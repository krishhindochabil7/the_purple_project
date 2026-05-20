import * as vscode from "vscode";

export interface GithubUserProfile {
  id: string;
  login: string;
  name: string;
  email: string;
}

const KEY = "github_user_profile";

export async function setGithubUserProfile(
  context: vscode.ExtensionContext,
  profile: GithubUserProfile
): Promise<void> {
  await context.globalState.update(KEY, profile);
}

export async function clearGithubUserProfile(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(KEY, undefined);
}
