// Lifetime supervisor, not a filesystem or network sandbox.
// The caller owns executable/argv/environment authorization.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowsProcessHost {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo {
        public IntPtr hProcess, hThread;
        public uint processId, threadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static string Quote(string value) {
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') quoted.Append('\\', slashes * 2 + 1);
            else quoted.Append('\\', slashes);
            slashes = 0;
            quoted.Append(c);
        }
        quoted.Append('\\', slashes * 2);
        return quoted.Append('"').ToString();
    }

    private static Exception Win32Failure(string operation) {
        return new InvalidOperationException(operation + ":" + Marshal.GetLastWin32Error());
    }

    public static int Main(string[] args) {
        IntPtr job = IntPtr.Zero;
        var process = new ProcessInfo();
        bool resumed = false;
        try {
            Guid launchId;
            if (args.Length < 2 || !Guid.TryParseExact(args[0], "D", out launchId) || !Path.IsPathRooted(args[1])) {
                throw new ArgumentException("INVALID_LAUNCH_ARGUMENTS");
            }
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Win32Failure("CREATE_JOB");
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, memory, false);
                if (!SetInformationJobObject(job, 9, memory, (uint)size)) throw Win32Failure("SET_JOB_LIMITS");
            } finally { Marshal.FreeHGlobal(memory); }

            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(-10);
            startup.hStdOutput = GetStdHandle(-11);
            startup.hStdError = GetStdHandle(-12);
            foreach (IntPtr handle in new[] {startup.hStdInput, startup.hStdOutput, startup.hStdError}) {
                if (!SetHandleInformation(handle, 1, 1)) throw Win32Failure("INHERIT_STDIO");
            }
            var commandLine = new StringBuilder();
            for (int i = 1; i < args.Length; i++) {
                if (i > 1) commandLine.Append(' ');
                commandLine.Append(Quote(args[i]));
            }
            if (!CreateProcess(args[1], commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref startup, out process)) {
                throw Win32Failure("CREATE_PROCESS");
            }
            if (!AssignProcessToJobObject(job, process.hProcess)) throw Win32Failure("ASSIGN_JOB");
            // Only the application reads stdin. Keeping a supervisor reader would falsely acknowledge
            // input after the application closed its own stdin and could hold EOF indefinitely.
            if (!CloseHandle(startup.hStdInput)) throw Win32Failure("CLOSE_SUPERVISOR_STDIN");
            // The child cannot emit a forged first frame: it is still suspended.
            Console.OutputEncoding = new UTF8Encoding(false);
            Console.WriteLine("TOOLFABRIC_PROCESS_READY:" + args[0] + ":" + process.processId);
            Console.Out.Flush();
            if (ResumeThread(process.hThread) == UInt32.MaxValue) throw Win32Failure("RESUME_PROCESS");
            resumed = true;
            if (WaitForSingleObject(process.hProcess, UInt32.MaxValue) != 0) throw Win32Failure("WAIT_PROCESS");
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) throw Win32Failure("READ_EXIT_CODE");
            return unchecked((int)exitCode);
        } catch (Exception error) {
            Console.Error.WriteLine("TOOLFABRIC_PROCESS_HOST_ERROR:" + error.Message);
            return 125;
        } finally {
            if (!resumed && process.hProcess != IntPtr.Zero) {
                TerminateProcess(process.hProcess, 125);
                WaitForSingleObject(process.hProcess, 5000);
            }
            // Closing the last job handle kills remaining ordinary descendants.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        }
    }
}
