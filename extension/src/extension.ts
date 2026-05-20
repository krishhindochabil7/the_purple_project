import * as vscode from "vscode";
import { startCopilotBridge } from "./copilotBridge";

export function activate(context: vscode.ExtensionContext) {
  console.log(
    "WORKSPACE:",
    vscode.workspace.workspaceFolders?.map(
      (f) => f.uri.fsPath
    )
  );
  const bridge = startCopilotBridge(context);
  context.subscriptions.push(bridge);

  const provider = new JiraCopilotProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("jiraCopilot.sidebar", provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
}

class JiraCopilotProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")]
    };
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const nonce = getNonce();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:8000;">
  <title>JiraCopilot</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__JIRA_COPILOT_WORKSPACE_PATH__ = ${JSON.stringify(workspacePath)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

webview.onDidReceiveMessage(async (message) => {
  switch (message.type) {
    case "openExternal":
      if (message.url) {
        await vscode.env.openExternal(
          vscode.Uri.parse(message.url)
        );
      }
      break;
  }
});
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {}
