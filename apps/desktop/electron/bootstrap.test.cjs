"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const {
  bootstrap,
  parseDesktopStartPath,
  resolveDesktopStartPath,
  desktopWebUrl,
  installPayloadAtomically,
  writeInstallCheckpoint,
  parseDesktopPort,
  assertPostmasterIdentity,
  ownedPostgresRunning,
  stopOwnedPostgres,
  buildDesktopEnvironment,
  ensureDatabaseState,
  bindDatabaseState,
  completeDatabaseHardening,
  secureInitdbArgs,
  renderStrictPgHba,
  enforceStrictPgHba,
  validateDatabaseHelper,
  acquireBootstrapLock,
  tarExtractionPlan,
} = require("./bootstrap.cjs");

function assertPrivateFile(file) {
  const stat = fs.statSync(file);
  assert.equal(stat.isFile(), true);
  // Windows 的 fs.stat().mode 不表达 POSIX owner/group/other 权限；文件继承当前用户
  // support 目录 ACL，不能用恒假的 0600 位比较阻断 Windows runner。
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
}

function fixture(version, withCurrent = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-"));
  const sourceRoot = path.join(root, "payload");
  const supportDir = path.join(root, "support");
  for (const part of ["runtime", "node", "pg", "nats"]) {
    fs.mkdirSync(path.join(sourceRoot, part), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, part, "payload.txt"), `${part}-${version}`);
  }
  fs.writeFileSync(path.join(sourceRoot, "runtime", "VERSION"), version);
  fs.mkdirSync(supportDir, { recursive: true });
  if (withCurrent) {
    for (const part of ["runtime", "node", "pg", "nats"]) {
      fs.mkdirSync(path.join(supportDir, part), { recursive: true });
      fs.writeFileSync(path.join(supportDir, part, "current.txt"), `${part}-old`);
    }
    fs.writeFileSync(path.join(supportDir, "runtime", ".env"), "JWT_SECRET=keep-me\n");
    fs.writeFileSync(path.join(supportDir, "VERSION"), "1.0.0\n");
    fs.writeFileSync(path.join(supportDir, ".bootstrapped"), "done");
  }
  return { root, sourceRoot, supportDir };
}

function transientDirectories(supportDir) {
  return fs.readdirSync(supportDir).filter((name) => /^\.install-(?:staging|backup)-/.test(name));
}

describe("桌面载荷原子装配", () => {
  it("源码与安装包启动路径只采用受控本地路由，保留旧产品根路由默认", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-start-route-"));
    const packageFile = path.join(root, "package.json");
    try {
      assert.equal(parseDesktopStartPath(), "/");
      assert.equal(resolveDesktopStartPath({ packageFile }), "/");
      fs.writeFileSync(packageFile, JSON.stringify({ workloomStartPath: "/development" }));
      assert.equal(resolveDesktopStartPath({ packageFile }), "/development");
      assert.equal(resolveDesktopStartPath({ packageFile, configured: "/settings" }), "/settings");
      assert.equal(desktopWebUrl(5373, "/development"), "http://127.0.0.1:5373/development");
      for (const configured of [null, "", "//evil.invalid", "https://evil.invalid", "/../settings", "/%2e%2e/settings",
        "/development?x=1", "/development#hash", "/a\\b", "/a\nb"]) {
        assert.throws(() => resolveDesktopStartPath({ packageFile, configured }), /START_PATH/);
      }
      fs.writeFileSync(packageFile, "{broken}");
      assert.throws(() => resolveDesktopStartPath({ packageFile }), /无法读取或解析/);
      const untouched = path.join(root, "must-not-create");
      await assert.rejects(bootstrap({ resourcesDir: root, supportDir: untouched, startPath: "//evil.invalid" }), /START_PATH/);
      assert.equal(fs.existsSync(untouched), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("解析物理路径后向 tar 传相对路径，并为 Windows 跨盘符暂存归档", () => {
    const destination = "D:\\a\\_temp\\wl-smoke\\.payload-cache";
    const sameDrive = tarExtractionPlan(
      "D:\\a\\workloom-im\\release\\resources\\payload.tar.gz",
      destination,
      { pathApi: path.win32, realpath: (value) => value },
    );
    assert.equal(sameDrive.cwd, destination);
    assert.equal(sameDrive.stagedArchive, null);
    assert.equal(path.win32.isAbsolute(sameDrive.archiveArg), false);
    assert.doesNotMatch(sameDrive.archiveArg, /[A-Za-z]:|\\/u);

    const crossDrive = tarExtractionPlan(
      "C:\\Program Files\\WorkLoom\\resources\\payload.tar.gz",
      destination,
      { pathApi: path.win32, realpath: (value) => value },
    );
    assert.equal(crossDrive.cwd, destination);
    assert.equal(crossDrive.archiveArg, ".workloom-payload.tar.gz");
    assert.equal(crossDrive.stagedArchive, path.win32.join(destination, ".workloom-payload.tar.gz"));

    const macSymlink = tarExtractionPlan(
      "/Users/runner/work/workloom-im/resources/payload.tar.gz",
      "/tmp/wl-smoke/.payload-cache",
      {
        pathApi: path.posix,
        realpath: (value) => value.startsWith("/tmp/") ? `/private${value}` : value,
      },
    );
    assert.equal(macSymlink.cwd, "/private/tmp/wl-smoke/.payload-cache");
    assert.equal(macSymlink.archiveArg, "../../../../Users/runner/work/workloom-im/resources/payload.tar.gz");
  });

  it("正式打包入口缺少载荷时在启动任何服务前失败关闭", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-payload-missing-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(resourcesDir, { recursive: true });
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, ".bootstrap-lock")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "node")), false);
      assert.equal(fs.existsSync(path.join(supportDir, "pg")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("正式打包入口不会把源码 dist-payload 双重嵌套误认作 Resources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-packaged-no-double-payload-"));
    const resourcesDir = path.join(root, "resources");
    const supportDir = path.join(root, "support");
    fs.mkdirSync(path.join(resourcesDir, "dist-payload", "runtime"), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "PAYLOAD_VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload", "runtime", "VERSION"), "9.9.9\n");
    fs.writeFileSync(path.join(resourcesDir, "dist-payload.tar.gz"), "not-a-release-resource\n");
    try {
      await assert.rejects(
        bootstrap({ resourcesDir, supportDir, smoke: true }),
        /载荷版本标记缺失/u,
      );
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("旧缓存提前写入版本号后中断解压，重启重新提取并暂存完整载荷", async () => {
    const { root, sourceRoot, supportDir } = fixture("2.0.0", false);
    const archiveFile = path.join(root, "payload.tar.gz");
    const cacheDir = path.join(supportDir, ".payload-cache");
    try {
      fs.writeFileSync(path.join(root, "PAYLOAD_VERSION"), "2.0.0\n");
      fs.writeFileSync(path.join(sourceRoot, "PAYLOAD_VERSION"), "2.0.0\n");
      const archived = spawnSync("tar", ["-czf", archiveFile, "-C", sourceRoot, "."], { encoding: "utf8" });
      assert.equal(archived.status, 0, archived.stderr || archived.error?.message);
      fs.mkdirSync(path.join(cacheDir, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "PAYLOAD_VERSION"), "2.0.0\n");
      fs.writeFileSync(path.join(cacheDir, "runtime", "VERSION"), "2.0.0\n");
      fs.writeFileSync(path.join(supportDir, "VERSION"), "2.0.0\n");
      await assert.rejects(bootstrap({ resourcesDir: root, supportDir, smoke: true, failAt: "after-stage" }), /安装故障注入：after-stage/u);
      assert.equal(fs.readFileSync(path.join(cacheDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
      assert.equal(fs.readFileSync(path.join(cacheDir, ".extraction-complete"), "utf8"), "2.0.0\n");
      assert.equal(fs.existsSync(path.join(supportDir, "runtime")), false);
      assert.equal(fs.existsSync(path.join(supportDir, ".bootstrap-lock")), false);
      fs.unlinkSync(path.join(cacheDir, "runtime", "payload.txt"));
      fs.writeFileSync(path.join(cacheDir, "runtime", "cache-still-reused.txt"), "complete");
      await assert.rejects(bootstrap({ resourcesDir: root, supportDir, smoke: true, failAt: "after-stage" }), /安装故障注入：after-stage/u);
      assert.equal(fs.readFileSync(path.join(cacheDir, "runtime", "cache-still-reused.txt"), "utf8"), "complete");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("完整暂存后换入；提交前可回滚，提交后清理临时目录", () => {
    const f = fixture("2.0.0");
    const tx = installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      previousEnv: Buffer.from("JWT_SECRET=keep-me\n"),
    });
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", ".env"), "utf8"), "JWT_SECRET=keep-me\n");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "2.0.0");
    assert.equal(fs.existsSync(path.join(f.supportDir, ".bootstrapped")), false);
    tx.commit();
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("提交清理故障发生在不可逆边界之后，不会重新开放旧载荷回滚", () => {
    const f = fixture("2.0.0");
    const tx = installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "during-commit-cleanup",
    });
    tx.commit();
    tx.rollback();
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "payload.txt"), "utf8"), "runtime-2.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "2.0.0");
  });

  it("换入第一项后故障会恢复旧版目录、版本和首航状态", () => {
    const f = fixture("2.0.0");
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-first-swap",
    }), /故障注入/);
    assert.equal(fs.readFileSync(path.join(f.supportDir, "runtime", "current.txt"), "utf8"), "runtime-old");
    assert.equal(fs.readFileSync(path.join(f.supportDir, "VERSION"), "utf8").trim(), "1.0.0");
    assert.equal(fs.readFileSync(path.join(f.supportDir, ".bootstrapped"), "utf8"), "done");
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("首装暂存失败不会留下半套运行时", () => {
    const f = fixture("2.0.0", false);
    assert.throws(() => installPayloadAtomically({
      sourceRoot: f.sourceRoot,
      supportDir: f.supportDir,
      payloadVer: "2.0.0",
      failAt: "after-stage",
    }), /故障注入/);
    for (const part of ["runtime", "node", "pg", "nats"]) assert.equal(fs.existsSync(path.join(f.supportDir, part)), false);
    assert.equal(fs.existsSync(path.join(f.supportDir, "VERSION")), false);
    assert.deepEqual(transientDirectories(f.supportDir), []);
  });

  it("安装阶段检查点以机器可读中文状态落盘", () => {
    const f = fixture("2.0.0", false);
    writeInstallCheckpoint(f.supportDir, {
      status: "running", phase: "database", detail: "正在准备数据库",
      recoverable: true, percent: 70, etaSeconds: 38,
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.supportDir, "install-state.json"), "utf8"));
    assert.equal(state.schemaVersion, "workloom.install-state/v1");
    assert.equal(state.phase, "database");
    assert.equal(state.recoverable, true);
    assert.equal(state.percent, 70);
    assert.equal(state.etaSeconds, 38);
  });

  it("启动页使用确定进度语义，不再显示循环假进度", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /aria-valuenow=/);
    assert.match(source, /进度按已完成的启动检查点更新/);
    assert.doesNotMatch(source, /animation:slide/);
  });

  it("源码主进程只复用已验活服务，正式安装包与渲染冒烟不能绕过载荷", () => {
    const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(app\.isPackaged\)[\s\S]*正式安装包禁止源码模式/u);
    assert.match(source, /if \(SOURCE_MODE\)[\s\S]*if \(RENDER_SMOKE\)[\s\S]*源码模式禁止执行发布渲染冒烟/u);
    assert.match(source, /else \{[\s\S]*handle = await bootstrap\(\{[\s\S]*resourcesDir/u);
  });

  it("发布渲染冒烟使用稳定动作标记走完真实欢迎流程", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
    const welcomeSource = fs.readFileSync(path.join(__dirname, "../../web/src/components/WelcomeCeremony.tsx"), "utf8");
    for (const action of ["skip-team", "enter-system"]) {
      assert.ok(mainSource.includes(`data-welcome-action="${action}"`));
      assert.ok(welcomeSource.includes(`data-welcome-action="${action}"`));
    }
    assert.doesNotMatch(mainSource, /textContent\?\.includes\(['"](?:跳过仪式|进入系统)/u);
  });
});

describe("桌面 PostgreSQL 实例归属与端口契约", () => {
  it("严格拒绝空白、小数、非数字和越界端口", () => {
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, {}), 5432);
    assert.equal(parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: "55432" }), 55432);
    for (const value of ["", " 5432", "5432 ", "5432.5", "port", "0", "65536"]) {
      assert.throws(
        () => parseDesktopPort("WORKLOOM_PG_PORT", 5432, { WORKLOOM_PG_PORT: value }),
        /1 到 65535/u,
      );
    }
  });

  it("只有 pg_ctl 确认运行且 postmaster 数据目录与端口同时匹配才允许复用", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-owner-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${pgData}\n1\n55432\n/tmp\n127.0.0.1\n`);
    const calls = [];
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData,
        expectedPort: 55432,
        runCommand(command, args) { calls.push({ command, args }); return { code: 0 }; },
      }), true);
      assert.deepEqual(calls, [{ command: "/runtime/pg_ctl", args: ["status", "-D", pgData] }]);
      assert.throws(() => assertPostmasterIdentity(pgData, 55433), /运行端口 55432/u);

      const foreign = path.join(root, "foreign");
      fs.mkdirSync(foreign);
      fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${foreign}\n1\n55432\n/tmp\n127.0.0.1\n`);
      assert.throws(() => assertPostmasterIdentity(pgData, 55432), /数据目录不属于当前产品/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pg_ctl 未确认运行时不读取残留 PID，也不把端口监听者当作自有实例", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-stopped-"));
    try {
      assert.equal(ownedPostgresRunning({
        pgCtl: "/runtime/pg_ctl",
        pgData: path.join(root, "missing-pgdata"),
        expectedPort: 55432,
        runCommand() { return { code: 3 }; },
      }), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("退出前重新复验实例归属，PID 文件被替换时绝不发送 stop", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-pg-stop-owner-"));
    const pgData = path.join(root, "pgdata");
    const foreign = path.join(root, "foreign");
    fs.mkdirSync(pgData);
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(pgData, "postmaster.pid"), `31415\n${foreign}\n1\n55432\n/tmp\n127.0.0.1\n`);
    let stops = 0;
    try {
      assert.throws(() => stopOwnedPostgres({
        pgCtl: "/test-only/pg_ctl",
        pgData,
        expectedPort: 55432,
        logFile: path.join(root, "pg.log"),
        runCommand() { return { code: 0 }; },
        stopCommand() { stops += 1; return { code: 0 }; },
      }), /数据目录不属于当前产品/u);
      assert.equal(stops, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("托管环境只重写数据库与服务端口，保留其他用户配置", () => {
    const scheme = "postgres://";
    const original = [
      `DATABASE_URL=${scheme}postgres:test-only@localhost:5432/workloom`,
      "APP_DB_PASSWORD=test-only",
      "GATEWAY_DB_PASSWORD=test-only",
      `DATABASE_APP_URL=${scheme}workloom_app:test-only@localhost:5432/workloom`,
      `DATABASE_GATEWAY_URL=${scheme}workloom_gateway:test-only@localhost:5432/workloom`,
      "SERVER_PORT=8787",
      "WEB_PORT=5173",
      "LLM_MODEL=keep-user-choice",
      "",
    ].join("\n");
    const result = buildDesktopEnvironment(original, {
      pgPort: 55432,
      serverPort: 18787,
      webPort: 15173,
      adminPassword: "test-only",
      appPassword: "test-only",
      gatewayPassword: "test-only",
    });
    assert.match(result.text, /^LLM_MODEL=keep-user-choice$/mu);
    assert.match(result.text, /^SERVER_PORT=18787$/mu);
    assert.match(result.text, /^WEB_PORT=15173$/mu);
    for (const key of ["DATABASE_URL", "DATABASE_APP_URL", "DATABASE_GATEWAY_URL"]) {
      const value = result.text.match(new RegExp(`^${key}=(.*)$`, "mu"))?.[1];
      assert.equal(new URL(value).hostname, "127.0.0.1");
      assert.equal(new URL(value).port, "55432");
    }
  });
});

describe("桌面 PostgreSQL 凭据状态与 SCRAM 围栏", () => {
  function deterministicRandom() {
    let value = 1;
    return (size) => Buffer.alloc(size, value++);
  }

  function boundIdentity(supportDir, port = 55432) {
    const pgData = path.join(supportDir, "pgdata");
    return {
      systemIdentifier: "7654321098765432109",
      dataDirectory: pgData,
      hbaFile: path.join(pgData, "pg_hba.conf"),
      port,
    };
  }

  it("0600 状态文件生成三份互异随机凭据，重复启动不轮换", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-state-"));
    try {
      const first = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-legacy"],
        randomBytes: deterministicRandom(),
      });
      assert.equal(first.created, true);
      assertPrivateFile(first.file);
      assert.equal(new Set(Object.values(first.state.credentials)).size, 3);
      assert.equal(first.state.legacyOwnerPasswords[0], "test-only-legacy");
      const second = ensureDatabaseState(root, {
        randomBytes() { throw new Error("existing state must not rotate"); },
      });
      assert.equal(second.created, false);
      assert.deepEqual(second.state.credentials, first.state.credentials);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("损坏状态失败关闭；绑定 system_identifier 后才能完成并清除旧凭据", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-bind-"));
    try {
      const record = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-legacy"],
        randomBytes: deterministicRandom(),
      });
      const bound = bindDatabaseState(record.file, record.state, boundIdentity(root));
      assert.equal(bound.cluster.systemIdentifier, "7654321098765432109");
      assert.throws(
        () => bindDatabaseState(record.file, bound, { ...boundIdentity(root), systemIdentifier: "7654321098765432110" }),
        /systemIdentifier 与运行实例不一致/u,
      );
      const complete = completeDatabaseHardening(record.file, bound);
      assert.equal(complete.auth.status, "scram-sha-256");
      assert.deepEqual(complete.legacyOwnerPasswords, []);

      fs.writeFileSync(record.file, "{broken", { mode: 0o600 });
      assert.throws(() => ensureDatabaseState(root), /状态损坏/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("pending 状态可从恢复后的旧配置补充候选；hardened 后绝不重新收录", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-db-recovery-"));
    try {
      const first = ensureDatabaseState(root, { randomBytes: deterministicRandom() });
      assert.deepEqual(first.state.legacyOwnerPasswords, []);
      const recovered = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-recovered", "test-only-recovered"],
      });
      assert.deepEqual(recovered.state.legacyOwnerPasswords, ["test-only-recovered"]);
      const bound = bindDatabaseState(recovered.file, recovered.state, boundIdentity(root));
      completeDatabaseHardening(recovered.file, bound);
      const hardened = ensureDatabaseState(root, {
        legacyOwnerPasswords: ["test-only-must-not-return"],
      });
      assert.deepEqual(hardened.state.legacyOwnerPasswords, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("initdb 只接受 pwfile + SCRAM，HBA 只允许本机 SCRAM", () => {
    const args = secureInitdbArgs("/test-only/pgdata", "/test-only/pwfile");
    assert.ok(args.includes("--auth-host=scram-sha-256"));
    assert.ok(args.includes("--auth-local=scram-sha-256"));
    assert.ok(args.includes("--pwfile=/test-only/pwfile"));
    assert.equal(args.some((arg) => /trust|md5/iu.test(arg)), false);

    const hba = renderStrictPgHba();
    assert.match(hba, /^local all all scram-sha-256$/mu);
    assert.match(hba, /^host all all 127\.0\.0\.1\/32 scram-sha-256$/mu);
    assert.match(hba, /^host all all ::1\/128 scram-sha-256$/mu);
    assert.doesNotMatch(hba, /\b(?:trust|md5)\b|0\.0\.0\.0|::\/0/iu);
  });

  it("pending 迁移复验失败会原子恢复旧 HBA 并再次 reload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-hba-rollback-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    const original = "host all all 127.0.0.1/32 trust\n";
    fs.writeFileSync(path.join(pgData, "pg_hba.conf"), original);
    const calls = [];
    try {
      assert.throws(() => enforceStrictPgHba({
        pgData,
        pgCtl: "/test-only/pg_ctl",
        rollbackOnFailure: true,
        forceReload: true,
        runCommand(command, args) { calls.push({ command, args }); return { code: 0 }; },
        verifyCommand() { return { code: 1 }; },
      }), /新凭据复验失败/u);
      assert.equal(fs.readFileSync(path.join(pgData, "pg_hba.conf"), "utf8"), original);
      assert.equal(calls.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("即使磁盘 HBA 未变化也强制 reload，再以正反向凭据复验结果为准", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-hba-reload-"));
    const pgData = path.join(root, "pgdata");
    fs.mkdirSync(pgData);
    fs.writeFileSync(path.join(pgData, "pg_hba.conf"), renderStrictPgHba());
    let reloads = 0;
    try {
      const result = enforceStrictPgHba({
        pgData,
        pgCtl: "/test-only/pg_ctl",
        rollbackOnFailure: false,
        forceReload: true,
        runCommand() { reloads += 1; return { code: 0 }; },
        verifyCommand() { return { code: 0 }; },
      });
      assert.equal(result.changed, false);
      assert.equal(reloads, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("源码固定先提交新 payload 再创建状态或改库，且不含 trust initdb", () => {
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    const commit = source.indexOf("payloadTransaction?.commit();");
    const stateMutation = source.indexOf("const databaseStateRecord = ensureDatabaseState");
    const databaseMutation = source.indexOf('runDatabaseHelper("prepare"');
    assert.ok(commit > 0 && commit < stateMutation && stateMutation < databaseMutation);
    assert.doesNotMatch(source, /--auth=trust/u);
    assert.match(source, /password_encryption=scram-sha-256/u);
  });

  it("payload commit 前用内置 Node 语法检查安全 helper，校验失败立即阻断", () => {
    const calls = [];
    validateDatabaseHelper("/test-only/node", "/test-only/helper.mjs", (command, args) => {
      calls.push({ command, args });
      return { code: 0, out: "", err: "" };
    });
    assert.deepEqual(calls, [{
      command: "/test-only/node",
      args: ["--check", "/test-only/helper.mjs"],
    }]);
    assert.throws(
      () => validateDatabaseHelper("/test-only/node", "/test-only/helper.mjs", () => ({ code: 1, err: "test-only syntax" })),
      /语法校验失败/u,
    );
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    assert.ok(source.indexOf("validateDatabaseHelper(NODE_BIN, DB_HELPER)") < source.indexOf("payloadTransaction?.commit();"));
  });

  it("所有 migrate 入口在轮换 app/gateway 角色前固定本会话 SCRAM", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../../scripts/migrate.ts"), "utf8");
    const scram = source.indexOf("SET password_encryption = 'scram-sha-256'");
    const rotation = source.indexOf("const roles:");
    assert.ok(scram > 0 && scram < rotation);
  });
});

describe("Electron 安全引导与独立验收入口", () => {
  it("原子单实例锁拒绝活进程，并可接管死进程遗留锁", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-lock-"));
    let byte = 1;
    const randomBytes = (size) => Buffer.alloc(size, byte++);
    try {
      const first = acquireBootstrapLock(root, {
        pid: 41001, randomBytes, isProcessAlive: () => true,
      });
      const ownerFile = path.join(first.lockDir, "owner.json");
      assertPrivateFile(ownerFile);
      assert.throws(
        () => acquireBootstrapLock(root, {
          pid: 41002, randomBytes, isProcessAlive: () => true,
        }),
        /已在启动或运行/u,
      );

      const recovered = acquireBootstrapLock(root, {
        pid: 41003, randomBytes, isProcessAlive: () => false,
      });
      assert.equal(first.release(), false);
      assert.equal(recovered.release(), true);
      assert.equal(fs.existsSync(path.join(root, ".bootstrap-lock")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("独立启动缺少 --smoke 时在创建支持目录之前退出", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workloom-bootstrap-cli-"));
    const support = path.join(root, "must-not-create");
    try {
      const result = spawnSync(process.execPath, [path.join(__dirname, "bootstrap.cjs"), "--support", support],
        { encoding: "utf8", timeout: 5_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--smoke/u);
      assert.equal(fs.existsSync(support), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI 在启动前注册 INT/TERM/HUP，并用 AbortSignal 驱动初始化清理", () => {
    const source = fs.readFileSync(path.join(__dirname, "bootstrap.cjs"), "utf8");
    const signalRegistration = source.indexOf('for (const signalName of ["SIGINT", "SIGTERM", "SIGHUP"])');
    const invocation = source.indexOf("bootstrap({ resourcesDir, supportDir, smoke: true, signal: abortController.signal })");
    assert.ok(signalRegistration > 0 && signalRegistration < invocation);
    assert.match(source, /if \(abortSignal\?\.aborted\) throw new Error/u);
  });
});
