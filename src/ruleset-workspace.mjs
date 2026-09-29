const MAX_RULESETS_PER_WORKSPACE = 20;
const MAX_STORED_WORKSPACE_BYTES = 1536 * 1024;

export class RuleSetWorkspace {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    try {
      const input = await request.json();
      const action = String(input?.action || "");
      if (action === "rate-limit") return json(await this.rateLimit(input));
      if (action === "init") return json(await this.initialize(input));
      const state = await this.ctx.storage.get("workspace");
      if (!state) return json({ error: "workspace_not_found" }, 404);
      if (action === "public") return json(publicRuleSet(state, input.ruleSetId));
      if (!authorized(state, input.keyHash)) return json({ error: "workspace_unauthorized" }, 401);
      if (action === "list") return json({ workspace: privateWorkspace(state) });
      if (action === "read") return json(privateRuleSet(state, input.ruleSetId));
      if (action === "create") return json(await this.createRuleSet(state, input.document));
      if (action === "save") return json(await this.saveRuleSet(state, input.document, input.ifMatch));
      if (action === "remove") return json(await this.removeRuleSet(state, input.ruleSetId));
      return json({ error: "workspace_bad_action" }, 400);
    } catch (error) {
      return json({ error: error?.code === "workspace_storage_limit" ? error.code : "workspace_error", detail: error?.code === "workspace_storage_limit" ? "工作区容量超过当前存储上限，请缩小规则集后重试" : "Workspace request failed." }, 500);
    }
  }

  async persistWorkspace(state) {
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > MAX_STORED_WORKSPACE_BYTES) {
      const error = new Error("Workspace storage limit exceeded.");
      error.code = "workspace_storage_limit";
      throw error;
    }
    await this.ctx.storage.put("workspace", state);
  }

  async rateLimit(input) {
    const bucket = Math.floor(Date.now() / 60000);
    const limit = Number(input.limit);
    if (!Number.isFinite(limit) || limit <= 0) return { allowed: false };
    return this.ctx.storage.transaction(async txn => {
      const previous = await txn.get("rate");
      const count = previous?.bucket === bucket ? previous.count : 0;
      if (count >= limit) return { allowed: false };
      await txn.put("rate", { bucket, count: count + 1 });
      return { allowed: true };
    });
  }

  async initialize(input) {
    const existing = await this.ctx.storage.get("workspace");
    if (existing) return { workspace: privateWorkspace(existing), created: false };
    const state = {
      id: String(input.workspaceId || ""),
      keyHash: String(input.keyHash || ""),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rulesets: [],
    };
    if (!state.id || !state.keyHash) throw new Error("Workspace initialization is missing credentials.");
    await this.persistWorkspace(state);
    return { workspace: privateWorkspace(state), created: true };
  }

  async createRuleSet(state, document) {
    if (state.rulesets.length >= MAX_RULESETS_PER_WORKSPACE) return { error: "workspace_ruleset_limit", detail: `每个工作区最多 ${MAX_RULESETS_PER_WORKSPACE} 份规则集。` };
    const next = normalizeDocument(document, 1);
    if (!next) return { error: "ruleset_invalid", detail: "规则集内容无效。" };
    state.rulesets.push(next);
    state.updatedAt = Date.now();
    await this.persistWorkspace(state);
    return { ruleSet: privateRuleSet(state, next.id).ruleSet, workspace: privateWorkspace(state) };
  }

  async saveRuleSet(state, document, ifMatch) {
    const index = state.rulesets.findIndex((item) => item.id === String(document?.id || ""));
    if (index < 0) return { error: "ruleset_not_found" };
    const current = state.rulesets[index];
    if (Number(ifMatch) !== Number(current.revision)) return { error: "ruleset_conflict", ruleSet: privateRuleSet(state, current.id).ruleSet };
    const next = normalizeDocument(document, current.revision + 1, current.createdAt);
    if (!next) return { error: "ruleset_invalid", detail: "规则集内容无效。" };
    state.rulesets[index] = next;
    state.updatedAt = Date.now();
    await this.persistWorkspace(state);
    return { ruleSet: privateRuleSet(state, next.id).ruleSet, workspace: privateWorkspace(state) };
  }

  async removeRuleSet(state, ruleSetId) {
    const index = state.rulesets.findIndex((item) => item.id === String(ruleSetId || ""));
    if (index < 0) return { error: "ruleset_not_found" };
    state.rulesets.splice(index, 1);
    state.updatedAt = Date.now();
    await this.persistWorkspace(state);
    return { workspace: privateWorkspace(state) };
  }
}

function authorized(state, keyHash) {
  return Boolean(keyHash) && String(state.keyHash || "") === String(keyHash);
}

function normalizeDocument(document, revision, createdAt = Date.now()) {
  if (!document || typeof document !== "object") return null;
  const id = String(document.id || "");
  const content = String(document.content || "");
  const bytes = Number(document.bytes || new TextEncoder().encode(content).length);
  const ruleCount = Number(document.ruleCount || 0);
  if (!id || !content || !Number.isFinite(bytes) || bytes < 1 || !Number.isFinite(ruleCount) || ruleCount < 0) return null;
  return {
    id,
    name: String(document.name || "未命名规则集").slice(0, 120),
    routing: Number(document.routing || 0),
    content,
    bytes,
    ruleCount,
    revision,
    createdAt,
    updatedAt: Date.now(),
  };
}

function privateWorkspace(state) {
  return {
    id: state.id,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    ruleSets: (state.rulesets || []).map((item) => ({
      id: item.id,
      name: item.name,
      routing: item.routing,
      ruleCount: item.ruleCount,
      bytes: item.bytes,
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

function privateRuleSet(state, id) {
  const item = (state.rulesets || []).find((candidate) => candidate.id === String(id || ""));
  if (!item) return { error: "ruleset_not_found" };
  return { ruleSet: { ...item } };
}

function publicRuleSet(state, id) {
  const item = (state.rulesets || []).find((candidate) => candidate.id === String(id || ""));
  if (!item) return { error: "ruleset_not_found" };
  return { ruleSet: { id: item.id, name: item.name, revision: item.revision, updatedAt: item.updatedAt, content: item.content } };
}

function json(body, status = 200) {
  const resolvedStatus = body?.error === "workspace_storage_limit" ? 413
    : body?.error === "workspace_error" ? 500
    : body?.error === "workspace_not_found" || body?.error === "ruleset_not_found" ? 404
    : body?.error === "workspace_unauthorized" ? 401
      : body?.error === "ruleset_conflict" ? 409
        : body?.error ? 400 : status;
  return new Response(JSON.stringify(body), { status: resolvedStatus, headers: { "content-type": "application/json" } });
}
