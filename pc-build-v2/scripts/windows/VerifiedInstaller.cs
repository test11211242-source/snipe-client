using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// GUI subsystem: no console lifetime tied to Electron. Hold the verified file
// lock until NSIS starts; installation must wait for application shutdown.
internal static class VerifiedInstaller
{
    private static string logPath;
    private static bool ready;

    private static void Log(string message)
    {
        if (logPath == null) return;
        try { File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine); }
        catch { }
    }

    private static bool ParentRunning(int processId)
    {
        try { using (Process parent = Process.GetProcessById(processId)) return !parent.HasExited; }
        catch (ArgumentException) { return false; }
    }

    private static int Main()
    {
        try
        {
            string path = Environment.GetEnvironmentVariable("CR_TOOLS_INSTALLER_PATH");
            string hash = Environment.GetEnvironmentVariable("CR_TOOLS_INSTALLER_SHA512");
            long size;
            int parentId;
            if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) ||
                !String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase) ||
                hash == null || !Regex.IsMatch(hash, "^[A-Za-z0-9+/]{86}==$", RegexOptions.CultureInvariant) ||
                !Int64.TryParse(Environment.GetEnvironmentVariable("CR_TOOLS_INSTALLER_SIZE"), NumberStyles.None, CultureInfo.InvariantCulture, out size) || size < 1 ||
                !Int32.TryParse(Environment.GetEnvironmentVariable("CR_TOOLS_PARENT_PROCESS_ID"), NumberStyles.None, CultureInfo.InvariantCulture, out parentId) ||
                parentId < 1 || parentId == Process.GetCurrentProcess().Id)
                throw new InvalidOperationException("Invalid trusted installer metadata");

            logPath = path + ".install.log";
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length != size) throw new InvalidOperationException("Installer size mismatch");
                using (SHA512 sha = SHA512.Create())
                {
                    if (!String.Equals(Convert.ToBase64String(sha.ComputeHash(stream)), hash, StringComparison.Ordinal))
                        throw new InvalidOperationException("Installer hash mismatch");
                }
                Log("Verified installer; waiting for application exit");
                // Never access the pipe after acknowledgement; persist later diagnostics.
                using (StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), Encoding.ASCII))
                {
                    output.WriteLine("CR_TOOLS_INSTALLER_READY");
                    output.Flush();
                }
                ready = true;
                DateTime deadline = DateTime.UtcNow.AddMinutes(5);
                while (ParentRunning(parentId))
                {
                    if (DateTime.UtcNow >= deadline) throw new TimeoutException("Application did not exit before installer deadline");
                    Thread.Sleep(100);
                }
                Log("Application exited; starting installer");
                ProcessStartInfo start = new ProcessStartInfo(path, "/S --updated --force-run");
                start.UseShellExecute = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process installer = Process.Start(start))
                {
                    if (installer == null) throw new InvalidOperationException("Installer process was not created");
                    Log("Installer started");
                    if (!installer.WaitForExit(15 * 60 * 1000)) throw new TimeoutException("Installer did not finish before deadline");
                    if (installer.ExitCode != 0) throw new InvalidOperationException("Installer exited with code " + installer.ExitCode);
                    Log("Installation finished successfully");
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Log("FAILED: " + error.Message);
            if (!ready) { try { Console.Error.WriteLine(error.Message); } catch { } }
            return 1;
        }
    }
}
