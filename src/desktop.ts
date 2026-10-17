import { run } from "./exec.js";
import { isAllowedUrl } from "./guard.js";

/** Show a desktop notification. Returns false (never throws) when the OS refuses. */
export async function notify(title: string, message: string): Promise<boolean> {
  if (process.platform === "win32") {
    // Text is passed through environment variables so nothing in it is parsed as PowerShell.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$t = $xml.GetElementsByTagName('text')",
      "$t.Item(0).AppendChild($xml.CreateTextNode($env:PP_TITLE)) | Out-Null",
      "$t.Item(1).AppendChild($xml.CreateTextNode($env:PP_MESSAGE)) | Out-Null",
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
    ].join("; ");
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { PP_TITLE: title, PP_MESSAGE: message },
      timeoutMs: 20_000,
    });
    return result.ok;
  }
  if (process.platform === "darwin") {
    const result = await run("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, message]);
    return result.ok;
  }
  return (await run("notify-send", [title, message])).ok;
}

/** Open an https URL on github.com, npmjs.com, pypi.org or crates.io in the default browser. */
export async function openUrl(url: string): Promise<{ opened: boolean; reason?: string }> {
  if (!isAllowedUrl(url)) {
    return { opened: false, reason: `Refused to open ${url}: only https pages on github.com, npmjs.com, pypi.org and crates.io may be opened.` };
  }
  const result =
    process.platform === "win32"
      ? await run("rundll32.exe", ["url.dll,FileProtocolHandler", url])
      : await run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
  return result.ok || (process.platform === "win32" && !result.notFound) ? { opened: true } : { opened: false, reason: result.stderr || "Could not start the browser." };
}
