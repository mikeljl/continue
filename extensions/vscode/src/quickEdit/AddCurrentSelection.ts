import * as vscode from "vscode";

import { VerticalDiffManager } from "../diff/vertical/manager";
import { getRangeInFileWithContents } from "../util/addCode";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import EditDecorationManager from "./EditDecorationManager";
import { QuickEditShowParams } from "./QuickEditQuickPick";

export async function addCurrentSelectionToEdit({
  webviewProtocol,
  verticalDiffManager,
  args,
  editDecorationManager,
}: {
  webviewProtocol: VsCodeWebviewProtocol;
  verticalDiffManager: VerticalDiffManager;
  args: QuickEditShowParams | undefined;
  editDecorationManager: EditDecorationManager;
}) {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return;
  }

  const existingDiff = verticalDiffManager.getHandlerForFile(
    editor.document.fileName,
  );

  // If there's a diff currently being applied, then we just toggle focus back to the input
  if (existingDiff) {
    webviewProtocol?.request("focusContinueInput", undefined);
    return;
  }

  const startFromCharZero = editor.selection.start.with(undefined, 0);
  const document = editor.document;
  let lastLine, lastChar;
  // If the user selected onto a trailing line but didn't actually include any characters in it
  // they don't want to include that line, so trim it off.
  if (editor.selection.end.character === 0) {
    // This is to prevent the rare case that the previous line gets selected when user
    // is selecting nothing and the cursor is at the beginning of the line
    if (editor.selection.end.line === editor.selection.start.line) {
      lastLine = editor.selection.start.line;
    } else {
      lastLine = editor.selection.end.line - 1;
    }
  } else {
    lastLine = editor.selection.end.line;
  }
  lastChar = document.lineAt(lastLine).range.end.character;
  const endAtCharLast = new vscode.Position(lastLine, lastChar);
  const range =
    args?.range ?? new vscode.Range(startFromCharZero, endAtCharLast);

  const leanExt = vscode.extensions.getExtension("leanprover.lean4");
  if (!leanExt) {
    vscode.window.showErrorMessage("Lean 4 extension not installed.");
    return;
  }
  // if (!leanExt.isActive) await leanExt.activate();

  // console.log("Lean extension:", leanExt);
  // const leanExports: any = leanExt.exports;
  // console.log("Lean exports:", leanExports);
  // const features = await leanExports.lean4EnabledFeatures;
  // console.log("Language features:", features);
  // const clientProvider = features.clientProvider;
  // console.log("Client provider:", clientProvider);
  // const clientsMap: Map<string, any> = clientProvider.clients;
  // console.log("Clients map:", clientsMap);
  // const uri = editor.document.uri.toString();
  // // let clientWrapper = [...clientsMap.values()][0]; // default to first client
  // let clientWrapper = null;
  // for (const client_name of clientsMap.keys()) {
  //   if (uri.startsWith(client_name)) {
  //     clientWrapper = clientsMap.get(client_name);
  //     break;
  //   }
  // }
  // // const clientWrapper =
  // //   clientsMap.get(uri) ?? // file:///Users/mike/Desktop/pde_choksi/pde/PDE/Section_7_2_1.lean
  // //   [...clientsMap.values()][0]; // file:///Users/mike/Desktop/pde_choksi/pde
  // console.log("Using client:", clientWrapper);
  // const languageClient = clientWrapper.client;
  // const params = {
  //   textDocument: { uri: document.uri.toString() },
  //   position: { line: range.end.line, character: range.end.character }, //, character: range.end.character
  // };
  // const response = await languageClient._connection.sendRequest("$/lean/plainGoal", params);
  // console.log("LSP response:", response);
  // const goals = response.goals;
  // console.log("Goals:", goals);

  editDecorationManager.clear();
  editDecorationManager.addDecorations(editor, [range]);

  const rangeInFileWithContents = getRangeInFileWithContents(true, range);

  console.log("Adding current selection to edit:", rangeInFileWithContents);

  if (rangeInFileWithContents) {
    webviewProtocol?.request("setCodeToEdit", rangeInFileWithContents);

    // Un-select the current selection
    editor.selection = new vscode.Selection(
      editor.selection.anchor,
      editor.selection.anchor,
    );
  }
}
