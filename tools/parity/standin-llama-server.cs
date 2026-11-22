// Phase 1 launch stand-in for llama-server.exe (plan.md §2 Phase 1.1).
//
// Why this file exists: server.js spawns the user's serverPath with NO shell, and the two
// obvious stand-ins cannot be spawned by it on a current node:
//   - a .cmd/.bat shim -> spawn() throws EINVAL (node >= 18.20 / 20.12 / 21.7 refuse .bat/.cmd
//     without shell:true, CVE-2024-27980). fixtures/PATH-MAP.json's exe token was written as
//     FIXTURE_ROOT/bin/fake-llama-server.cmd, which the manager can therefore never spawn.
//   - a copy of node.exe renamed to fake-llama-server.exe -> node parses the app's own arg
//     vector as its own CLI options and dies with "bad option: --models-preset" (exit 9) before
//     any --require/NODE_OPTIONS preload runs, so /launch-presets and UI launches cannot be driven.
// This is a real PE that libuv can spawn with any arg vector, records the argv it was handed,
// and then relays the IDENTICAL arg vector to node.exe + fake-llama-server.js, so
// fake-llama-server.js keeps owning every knob (chunk shapes, exit codes, stderr-only, binds).
//
// Build (capture-legacy.sh rebuilds this on every run; the exe stays in scratch):
//   csc.exe -nologo -target:exe -out:<scratch>/bin/fake-llama-server.exe standin-llama-server.cs
// Relay target override: PARITY_NODE, PARITY_FAKE_SCRIPT (default: fake-llama-server.js next to
// this exe). Recording target: PARITY_ARGV_LOG (same jsonl contract as fake-llama-server.js).

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class StandInLlamaServer
{
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static string EscapeJson(string value)
    {
        StringBuilder sb = new StringBuilder();
        foreach (char c in value)
        {
            if (c == '"') { sb.Append("\\\""); }
            else if (c == '\\') { sb.Append("\\\\"); }
            else if (c == '\n') { sb.Append("\\n"); }
            else if (c == '\r') { sb.Append("\\r"); }
            else if (c == '\t') { sb.Append("\\t"); }
            else if (c < ' ') { sb.Append("\\u").Append(((int)c).ToString("x4")); }
            else { sb.Append(c); }
        }
        return sb.ToString();
    }

    // libuv builds the same shape (CommandLineToArgvW rules), so the relayed tokens parse back
    // to exactly the strings this process received.
    static string QuoteArg(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return value;
        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { backslashes += 1; continue; }
            if (c == '"') { sb.Append(new string('\\', backslashes * 2 + 1)).Append('"'); backslashes = 0; continue; }
            sb.Append(new string('\\', backslashes)).Append(c); backslashes = 0;
        }
        sb.Append(new string('\\', backslashes * 2)).Append('"');
        return sb.ToString();
    }

    static void RecordArgv(string[] args)
    {
        string log = Environment.GetEnvironmentVariable("PARITY_ARGV_LOG");
        if (string.IsNullOrEmpty(log)) return;
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"pid\":").Append(Process.GetCurrentProcess().Id).Append(",\"argv\":[");
        for (int i = 0; i < args.Length; i += 1)
        {
            if (i > 0) sb.Append(",");
            sb.Append("\"").Append(EscapeJson(args[i])).Append("\"");
        }
        sb.Append("],\"raw\":\"").Append(EscapeJson(Environment.CommandLine)).Append("\"}");
        File.AppendAllText(log, sb.ToString() + "\n", new UTF8Encoding(false));
    }

    // Raw byte forwarding: BaseStream, never OutputDataReceived, so the relay does not reassemble
    // lines or trim anything (plan.md §9 cross-stack trap 2).
    static void Relay(Stream from, Stream to)
    {
        byte[] buffer = new byte[16384];
        try
        {
            while (true)
            {
                int read = from.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                to.Write(buffer, 0, read);
                to.Flush();
            }
        }
        catch { }
    }

    static int Main(string[] args)
    {
        RecordArgv(args);

        string node = Environment.GetEnvironmentVariable("PARITY_NODE");
        if (string.IsNullOrEmpty(node)) node = "node";
        string script = Environment.GetEnvironmentVariable("PARITY_FAKE_SCRIPT");
        if (string.IsNullOrEmpty(script))
        {
            script = Path.Combine(Path.GetDirectoryName(System.Reflection.Assembly
                .GetExecutingAssembly().Location), "fake-llama-server.js");
        }

        StringBuilder cmdline = new StringBuilder(QuoteArg(script));
        foreach (string arg in args) cmdline.Append(' ').Append(QuoteArg(arg));

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = cmdline.ToString();
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("standin-llama-server: cannot relay to " + node + ": " + error.Message);
            return 127;
        }

        // Windows kill() is TerminateProcess: no handler runs here, so the relayed node child is
        // tied to a kill-on-close job object instead and dies with this process.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info));
            AssignProcessToJobObject(job, child.Handle);
        }

        Thread outThread = new Thread(delegate() { Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); });
        Thread errThread = new Thread(delegate() { Relay(child.StandardError.BaseStream, Console.OpenStandardError()); });
        outThread.IsBackground = true;
        errThread.IsBackground = true;
        outThread.Start();
        errThread.Start();

        child.WaitForExit();
        outThread.Join(2000);
        errThread.Join(2000);
        // Exiting closes the only job handle, which is what takes the relayed child down with us.
        return child.ExitCode;
    }
}
