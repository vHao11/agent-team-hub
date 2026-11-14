using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// 子进程在恢复执行前加入 Job；关闭 Job 时由系统终止仍属于该 Job 的进程。
public static class TeamHubProcessJob {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, STARTF_USESTDHANDLES = 0x100;
  const uint KILL_ON_JOB_CLOSE = 0x2000, HANDLE_FLAG_INHERIT = 1, WAIT_OBJECT_0 = 0, STILL_ACTIVE = 259;
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit BasicLimitInformation; public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int cb; public string reserved, desktop, title;
    public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2; public IntPtr reserved2Ptr, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting data, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(
    string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
    uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);

  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
    var result = new StringBuilder("\""); int slash = 0;
    foreach (char c in value) {
      if (c == '\\') { slash++; continue; }
      if (c == '"') { result.Append('\\', slash * 2 + 1); result.Append('"'); slash = 0; continue; }
      result.Append('\\', slash); slash = 0; result.Append(c);
    }
    result.Append('\\', slash * 2); result.Append('"'); return result.ToString();
  }
  static uint Active(IntPtr job) {
    Accounting result;
    if (!QueryInformationJobObject(job, 1, out result, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero))
      throw new InvalidOperationException("无法读取进程组状态。");
    return result.ActiveProcesses;
  }
  static void WriteResult(string file, bool confirmed) {
    File.WriteAllText(file, confirmed ? "{\"cancel_confirmed\":true}" : "{\"cancel_confirmed\":false}", new UTF8Encoding(false));
  }
  public static int Run(string binary, string[] args, string cwd, string cancel, string result) {
    IntPtr job = IntPtr.Zero, mem = IntPtr.Zero; ProcessInfo process = new ProcessInfo(); bool assigned = false;
    try {
      if (File.Exists(cancel)) { WriteResult(result, true); return 1; }
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new InvalidOperationException("无法创建进程组。");
      ExtendedLimit limits = new ExtendedLimit(); limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE;
      mem = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimit))); Marshal.StructureToPtr(limits, mem, false);
      if (!SetInformationJobObject(job, 9, mem, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new InvalidOperationException("无法配置进程组。");
      Startup startup = new Startup(); startup.cb = Marshal.SizeOf(typeof(Startup)); startup.flags = STARTF_USESTDHANDLES;
      startup.stdin = GetStdHandle(-10); startup.stdout = GetStdHandle(-11); startup.stderr = GetStdHandle(-12);
      foreach (IntPtr handle in new IntPtr[] { startup.stdin, startup.stdout, startup.stderr })
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
          throw new InvalidOperationException("无法传递执行器标准流。");
      var command = new StringBuilder(Quote(binary));
      foreach (string arg in args) command.Append(' ').Append(Quote(arg));
      if (!CreateProcess(binary, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW,
          IntPtr.Zero, cwd, ref startup, out process)) throw new InvalidOperationException("无法创建执行器进程。");
      if (!AssignProcessToJobObject(job, process.process)) throw new InvalidOperationException("无法监管执行器进程组。");
      assigned = true;
      bool cancelled = File.Exists(cancel); DateTime deadline = DateTime.MaxValue;
      if (cancelled) {
        deadline = DateTime.UtcNow.AddSeconds(15);
        if (!TerminateJobObject(job, 1)) { WriteResult(result, false); return 1; }
      } else if (ResumeThread(process.thread) == UInt32.MaxValue) throw new InvalidOperationException("无法启动执行器进程。");
      for (;;) {
        if (!cancelled && File.Exists(cancel)) {
          cancelled = true; deadline = DateTime.UtcNow.AddSeconds(15);
          if (!TerminateJobObject(job, 1)) { WriteResult(result, false); return 1; }
        }
        if (Active(job) == 0) break;
        if (cancelled && DateTime.UtcNow >= deadline) { WriteResult(result, false); return 1; }
        Thread.Sleep(100);
      }
      uint exitCode;
      if (!GetExitCodeProcess(process.process, out exitCode) || exitCode == STILL_ACTIVE) { WriteResult(result, false); return 1; }
      WriteResult(result, cancelled);
      return cancelled ? 1 : (int)exitCode;
    } catch {
      if (process.process != IntPtr.Zero && !assigned) TerminateProcess(process.process, 1);
      try { WriteResult(result, false); } catch { }
      return 1;
    } finally {
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      if (mem != IntPtr.Zero) Marshal.FreeHGlobal(mem);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
