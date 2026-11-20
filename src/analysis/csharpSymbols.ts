import * as vscode from 'vscode';

// Unity base classes recognized while walking a class's real inheritance chain (see
// extendsKnownUnityBaseType below) — not an exhaustive list of every Unity-mountable type, just the
// common subset actually seen day-to-day.
export const KNOWN_UNITY_BASE_TYPES = ['MonoBehaviour', 'Editor', 'EditorWindow', 'ScriptableObject'];

// ReSharper Code's DocumentSymbol names for methods include the full parameter list (e.g. "Awake()",
// "SetRaiseOffset(float offset)") rather than the bare identifier — callers comparing against a plain
// word (from a hover word-range, etc.) must strip it first or every comparison silently fails.
export function bareSymbolName(name: string): string {
	const parenIndex = name.indexOf('(');
	return parenIndex === -1 ? name : name.slice(0, parenIndex);
}

export interface FlatSymbol {
	name: string;
	kind: vscode.SymbolKind;
	range: vscode.Range;
	namePosition: vscode.Position;
}

function flattenDocumentSymbols(symbols: vscode.DocumentSymbol[], out: FlatSymbol[]): void {
	for (const symbol of symbols) {
		out.push({
			name: symbol.name,
			kind: symbol.kind,
			range: symbol.range,
			namePosition: symbol.selectionRange.start,
		});
		if (symbol.children.length > 0) {
			flattenDocumentSymbols(symbol.children, out);
		}
	}
}

// vscode.executeDocumentSymbolProvider can return either hierarchical DocumentSymbol[] (has
// .children/.selectionRange) or flat SymbolInformation[] (has .location, no children) depending on the
// provider — flattening both shapes into the same FlatSymbol[] means callers never need to care which one
// ReSharper Code actually returned.
export async function getFlatSymbols(document: vscode.TextDocument): Promise<FlatSymbol[]> {
	const result = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
		'vscode.executeDocumentSymbolProvider',
		document.uri
	);
	if (!result || result.length === 0) {
		return [];
	}

	if ('children' in result[0] && 'selectionRange' in result[0]) {
		const out: FlatSymbol[] = [];
		flattenDocumentSymbols(result as vscode.DocumentSymbol[], out);
		return out;
	}

	return (result as vscode.SymbolInformation[]).map((symbol) => ({
		name: symbol.name,
		kind: symbol.kind,
		range: symbol.location.range,
		namePosition: symbol.location.range.start,
	}));
}

// Picks the smallest-range symbol of the given kind whose range contains `position` — i.e. the innermost
// enclosing declaration, used to answer "what method/class is the cursor inside of" without a
// line-scanning regex.
export function findInnermostContaining(
	symbols: FlatSymbol[],
	position: vscode.Position,
	kind: vscode.SymbolKind
): FlatSymbol | undefined {
	let best: FlatSymbol | undefined;
	for (const symbol of symbols) {
		if (symbol.kind !== kind || !symbol.range.contains(position)) {
			continue;
		}
		if (!best || symbol.range.contains(best.range)) {
			best = symbol;
		}
	}
	return best;
}

// Defensive backstop against runaway walks through unexpectedly large/cyclic supertype graphs — real C#
// inheritance chains are nowhere near this deep.
const MAX_SUPERTYPES_VISITED = 500;

// Walks the *actual* inheritance chain via the type-hierarchy provider (ReSharper Code) instead of
// matching a single `class Foo : Bar` line with a regex — so a class extending a custom intermediate base
// (e.g. `MyBaseBehaviour : MonoBehaviour`) is still correctly recognized as Unity-mountable.
export async function extendsKnownUnityBaseType(uri: vscode.Uri, position: vscode.Position): Promise<boolean> {
	const roots = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
		'vscode.prepareTypeHierarchy',
		uri,
		position
	);
	const root = roots?.[0];
	if (!root) {
		return false;
	}

	const visited = new Set<string>();
	let queue: vscode.TypeHierarchyItem[] = [root];

	while (queue.length > 0 && visited.size < MAX_SUPERTYPES_VISITED) {
		const next: vscode.TypeHierarchyItem[] = [];
		for (const item of queue) {
			const key = `${item.uri.toString()}#${item.name}#${item.range.start.line}`;
			if (visited.has(key)) {
				continue;
			}
			visited.add(key);

			if (KNOWN_UNITY_BASE_TYPES.includes(item.name)) {
				return true;
			}

			const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
				'vscode.provideSupertypes',
				item
			);
			if (supertypes) {
				next.push(...supertypes);
			}
		}
		queue = next;
	}

	return false;
}
