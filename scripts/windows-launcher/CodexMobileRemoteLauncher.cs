using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class CodexMobileRemoteLauncher
{
    [STAThread]
    private static void Main()
    {
        var projectDir = AppContext.BaseDirectory;
        var marker = Path.Combine(projectDir, "scripts", "start-codex-mobile-stack.ps1");
        if (!File.Exists(marker))
        {
            projectDir = Directory.GetCurrentDirectory();
        }
        var scriptPath = Path.Combine(projectDir, "scripts", "start-codex-mobile-stack.ps1");
        var powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");

        if (!File.Exists(scriptPath))
        {
            MessageBox.Show(
                "没有找到启动脚本：" + Environment.NewLine + scriptPath,
                "Codex 手机远程",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -ExecutionPolicy Bypass -NoExit -File \"" + scriptPath + "\"",
            WorkingDirectory = projectDir,
            UseShellExecute = false
        };

        Process.Start(startInfo);
    }
}
