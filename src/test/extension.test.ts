import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension activation', () => {
	test('activates and registers its commands', async () => {
		const extension = vscode.extensions.getExtension('local.unity-for-cursor');
		assert.ok(extension, 'extension not found — check publisher.name in package.json');

		await extension!.activate();

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('cursorUnityAttach.attachToEditor'));
		assert.ok(commands.includes('unityForCursor.showEditorLog'));
	});
});
