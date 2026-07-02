import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

const APP_SOURCE_PATH = new URL("./App.tsx", import.meta.url);

function getAppSourceFile() {
  const source = readFileSync(APP_SOURCE_PATH, "utf8");
  return ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findAppDeclaration(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "App",
  );

  if (!declaration?.body) {
    throw new Error("App function declaration not found");
  }

  return declaration;
}

function isLoginGuard(statement: ts.Statement): statement is ts.IfStatement {
  return ts.isIfStatement(statement)
    && ts.isPrefixUnaryExpression(statement.expression)
    && statement.expression.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIdentifier(statement.expression.operand)
    && statement.expression.operand.text === "isLoggedIn";
}

function containsHookCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const expression = node.expression;
    if (ts.isIdentifier(expression) && /^use[A-Z0-9_]/.test(expression.text)) {
      return true;
    }
  }

  return ts.forEachChild(node, containsHookCall) ?? false;
}

describe("App hook order", () => {
  test("does not call hooks after the unauthenticated early return", () => {
    const sourceFile = getAppSourceFile();
    const appDeclaration = findAppDeclaration(sourceFile);
    const statements = appDeclaration.body!.statements;
    const guardIndex = statements.findIndex(isLoginGuard);

    expect(guardIndex).toBeGreaterThanOrEqual(0);

    const statementsAfterGuard = statements.slice(guardIndex + 1);
    const hookStatementsAfterGuard = statementsAfterGuard.filter((statement) => containsHookCall(statement));

    expect(hookStatementsAfterGuard).toHaveLength(0);
  });
});
