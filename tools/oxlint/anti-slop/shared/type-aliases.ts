import type { ESTree } from "@oxlint/plugins";

export function referencedAliasName(type: ESTree.TSType): string | null {
	if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
	return type.typeArguments === null ||
		type.typeArguments === undefined ||
		type.typeArguments.params.length === 0
		? type.typeName.name
		: null;
}

export function collectTypeAliases(
	program: ESTree.Program,
): ReadonlyMap<string, ESTree.TSTypeAliasDeclaration> {
	const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
	for (const statement of program.body) {
		const declaration =
			statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
		if (declaration?.type === "TSTypeAliasDeclaration") {
			aliases.set(declaration.id.name, declaration);
		}
	}
	return aliases;
}
