import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const SAFETY_PATTERN = /\bSAFETY\s*:/u;

// The walk must stop at the statement list holding the assertion's own statement:
// climbing further would let one comment above a function justify every assertion
// inside it.
const statementListContainers = new Set([
  "BlockStatement",
  "ClassBody",
  "Program",
  "StaticBlock",
  "SwitchCase",
  "TSModuleBlock",
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
    .some((comment) => comment.end <= node.start && SAFETY_PATTERN.test(comment.value));
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (hasSafetyCommentBefore(sourceCode, current, node)) return true;
    const parent: ESTree.Node | null = current.parent;
    if (parent === null || statementListContainers.has(parent.type)) return false;
    current = parent;
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
