using System;
using System.Threading;
using System.Windows.Forms;

namespace ShorthandExpander
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            using var mutex = new Mutex(true, "ShorthandExpander.SingleInstance", out bool createdNew);
            if (!createdNew)
            {
                MessageBox.Show("Shorthand Expander is already running. Look for its icon in the system tray.",
                    "Shorthand Expander", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApplicationContext());
        }
    }
}
