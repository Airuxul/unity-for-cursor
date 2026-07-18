import * as vscode from 'vscode';

// Covers the common subset of Unity "message methods" actually seen day-to-day (matching what
// Rider's own Unity support surfaces in practice) — not an exhaustive list of every callback
// Unity's scripting reference documents.
const LIFECYCLE_METHODS: Record<string, string> = {
	Awake: '对象被加载后立即调用一次，早于任何 `Start`。即使脚本被禁用也会调用。',
	OnEnable: '对象变为可用/激活时调用（包括脚本被重新启用、对象被启用）。',
	Start: '对象首次激活前的第一帧调用一次，晚于所有 `Awake`。',
	FixedUpdate: '以固定的物理时间步长调用，帧率无关——物理相关逻辑应放在这里。',
	Update: '每帧调用一次，是最常用的逐帧逻辑入口。',
	LateUpdate: '在本帧所有 `Update` 执行完毕后调用（常用于跟随摄像机等需要"后处理"的逻辑）。',
	OnDisable: '对象变为不可用/禁用时调用。',
	OnDestroy: '对象被销毁前调用一次，用于清理资源。',
	OnGUI: '每帧多次调用（IMGUI 渲染事件），用于绘制传统 GUI。',
	OnValidate: '仅编辑器下：脚本被加载或 Inspector 中的值被修改时调用。',
	Reset: '仅编辑器下：为组件赋予默认值时调用（首次添加组件或点击 Reset）。',
	OnApplicationQuit: '应用退出前对所有激活对象调用一次。',
	OnApplicationPause: '应用暂停/恢复时调用。',
	OnApplicationFocus: '应用获得/失去焦点时调用。',
	OnCollisionEnter: '碰撞体开始接触时调用一次（3D 物理）。',
	OnCollisionStay: '碰撞体保持接触期间每帧调用（3D 物理）。',
	OnCollisionExit: '碰撞体分离时调用一次（3D 物理）。',
	OnCollisionEnter2D: '碰撞体开始接触时调用一次（2D 物理）。',
	OnCollisionStay2D: '碰撞体保持接触期间每帧调用（2D 物理）。',
	OnCollisionExit2D: '碰撞体分离时调用一次（2D 物理）。',
	OnTriggerEnter: '触发器开始重叠时调用一次（3D 物理）。',
	OnTriggerStay: '触发器保持重叠期间每帧调用（3D 物理）。',
	OnTriggerExit: '触发器分离时调用一次（3D 物理）。',
	OnTriggerEnter2D: '触发器开始重叠时调用一次（2D 物理）。',
	OnTriggerStay2D: '触发器保持重叠期间每帧调用（2D 物理）。',
	OnTriggerExit2D: '触发器分离时调用一次（2D 物理）。',
	OnMouseDown: '用户在该对象的 Collider 上按下鼠标时调用。',
	OnMouseUp: '用户在该对象的 Collider 上释放鼠标时调用。',
	OnMouseEnter: '鼠标指针进入该对象的 Collider 范围时调用。',
	OnMouseExit: '鼠标指针离开该对象的 Collider 范围时调用。',
	OnMouseOver: '鼠标指针停留在该对象的 Collider 范围内期间每帧调用。',
	OnDrawGizmos: '每帧在 Scene 视图中绘制 Gizmos 时调用（对象未必被选中）。',
	OnDrawGizmosSelected: '仅当对象被选中时，每帧在 Scene 视图中绘制 Gizmos 时调用。',
	OnBecameVisible: '对象的 Renderer 对任意摄像机变为可见时调用。',
	OnBecameInvisible: '对象的 Renderer 对所有摄像机都变为不可见时调用。',
	OnAnimatorMove: '启用 Animator 且开启 Apply Root Motion 时，每帧调用以应用根运动。',
	OnAnimatorIK: '启用 Animator 且设置了 IK Pass 时，每帧调用以处理 IK。',
};

// Method declarations look like "private void Update()" / "IEnumerator Start()" etc. — this only
// matches the declaration line itself, not arbitrary call sites, to keep false positives down.
const DECLARATION_LINE_PATTERN =
	/(?:private|protected|internal|public)?\s*(?:void|IEnumerator|System\.Collections\.IEnumerator)\s+(\w+)\s*\(/;

// Unity base classes this heuristic recognizes directly. Only a single level of inheritance is
// checked — a class extending a custom intermediate base (e.g. "MyBaseBehaviour") won't be
// recognized, since that would require real semantic/type analysis this extension doesn't have.
const KNOWN_UNITY_BASE_TYPES = ['MonoBehaviour', 'Editor', 'EditorWindow', 'ScriptableObject'];
const CLASS_DECLARATION_PATTERN = /class\s+\w+\s*:\s*([\w.,\s<>]+)/;
const MAX_LINES_TO_SCAN_UPWARD = 500;

function isInsideKnownUnityClass(document: vscode.TextDocument, fromLine: number): boolean {
	const start = Math.max(0, fromLine - MAX_LINES_TO_SCAN_UPWARD);
	for (let i = fromLine; i >= start; i--) {
		const match = document.lineAt(i).text.match(CLASS_DECLARATION_PATTERN);
		if (match) {
			return KNOWN_UNITY_BASE_TYPES.some((base) => match[1].includes(base));
		}
	}
	return false;
}

export function registerLifecycleHover(context: vscode.ExtensionContext): void {
	if (!vscode.workspace.getConfiguration('unityForCursor').get<boolean>('enableLifecycleHover', true)) {
		return;
	}

	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			{ language: 'csharp' },
			{
				provideHover(document, position) {
					const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
					if (!wordRange) {
						return undefined;
					}
					const word = document.getText(wordRange);
					const description = LIFECYCLE_METHODS[word];
					if (!description) {
						return undefined;
					}

					const lineText = document.lineAt(position.line).text;
					const declMatch = lineText.match(DECLARATION_LINE_PATTERN);
					if (!declMatch || declMatch[1] !== word) {
						return undefined;
					}

					if (!isInsideKnownUnityClass(document, position.line)) {
						return undefined;
					}

					const markdown = new vscode.MarkdownString();
					markdown.appendMarkdown(`**Unity 消息方法**: \`${word}\`\n\n${description}`);
					return new vscode.Hover(markdown, wordRange);
				},
			}
		)
	);
}
