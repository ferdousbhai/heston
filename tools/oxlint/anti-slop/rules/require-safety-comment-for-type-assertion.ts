import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function hasSafetyCommentBefore(
  sourceCode: SourceCode,
  target: ESTree.Node,
  node: TypeAssertion,
): boolean {
  return sourceCode
    .getCommentsBefore(target)
    .some((comment) => comment.end <= node.start && /\bSAFETY\s*:/u.test(comment.value));
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (hasSafetyCommentBefore(sourceCode, current, node)) return true;
    if (commentOwnerKinds.has(current.type)) {
      // An exported declaration starts at `const`, so a comment written above
      // the `export` line attaches to the export node instead.
      const { parent } = current;
      return (
        parent.type === "ExportNamedDeclaration" &&
        hasSafetyCommentBefore(sourceCode, parent, node)
      );
    }
    if (current.parent.type === "Program") return false;
    current = current.parent;
  }
}

export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
