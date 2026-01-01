const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const writeResult = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

const fail = (message) => {
  writeResult({ result: { error: message }, is_error: true });
  process.exit(0);
};

const raw = await readStdin();
let payload;
try {
  payload = raw.trim() ? JSON.parse(raw) : null;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!payload || typeof payload.toolName !== 'string') {
  fail('missing toolName');
}

const registryModule = new URL('../dist/tools/registry.js', import.meta.url);
const workspaceModule = new URL('../dist/tools/workspace.js', import.meta.url);
const patchModule = new URL('../dist/tools/patch.js', import.meta.url);
const executorModule = new URL('../dist/tools/executor.js', import.meta.url);

const [{ ToolRegistry }, { createWorkspaceReadTool }, { createPatchApplyTool }, { RegistryToolExecutor }] =
  await Promise.all([
    import(registryModule.href),
    import(workspaceModule.href),
    import(patchModule.href),
    import(executorModule.href)
  ]);

const registry = new ToolRegistry();
registry.register(createWorkspaceReadTool());
registry.register(createPatchApplyTool());

const workspaceRoot =
  typeof payload.workspaceRoot === 'string' && payload.workspaceRoot.length > 0
    ? payload.workspaceRoot
    : process.cwd();

const executor = new RegistryToolExecutor(registry, { workspaceRoot });
const result = await executor.execute(payload.toolName, payload.input ?? null);
writeResult(result);
