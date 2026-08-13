// src/main/git.js
const fs = require("fs-extra");
const path = require("path");
const { exec, spawn } = require("child_process");
const log = require("./logger");

// Default exclude patterns per project type
const DEFAULT_EXCLUDES = {
  wordpress: [
    "wp-content/cache",
    "wp-content/upgrade",
    "wp-content/uploads",
    "wp-content/debug.log",
    "node_modules",
    ".DS_Store",
    "Thumbs.db",
  ],
  laravel: [
    "vendor",
    "node_modules",
    "storage/logs",
    "storage/framework/cache",
    "storage/framework/sessions",
    "storage/framework/views",
    ".env",
    ".DS_Store",
  ],
  node: [
    "node_modules",
    ".env",
    "dist",
    "build",
    ".DS_Store",
  ],
  nextjs: [
    "node_modules",
    ".next",
    ".env",
    ".env.local",
    "out",
    ".DS_Store",
  ],
  php: [
    "vendor",
    "node_modules",
    ".env",
    ".DS_Store",
  ],
};

// Default include paths per project type (what to push)
const DEFAULT_INCLUDES = {
  wordpress: [
    "wp-content/plugins",
    "wp-content/themes",
  ],
  laravel: [
    "app",
    "config",
    "database",
    "resources",
    "routes",
    "public",
    "composer.json",
    "composer.lock",
    "package.json",
    "vite.config.js",
    "webpack.mix.js",
  ],
  node: ["."],
  nextjs: ["."],
  php: ["."],
};

function gitExec(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ success: false, message: stderr || err.message, output: stdout });
      else resolve({ success: true, output: stdout, error: stderr });
    });
  });
}

async function getGitConfig(projId) {
  const { PROJECTS_DIR } = global.CONST;
  const gitConfigPath = path.join(PROJECTS_DIR, projId, "git-config.json");
  if (await fs.pathExists(gitConfigPath)) {
    return fs.readJson(gitConfigPath);
  }
  return null;
}

async function saveGitConfig(projId, config) {
  const { PROJECTS_DIR } = global.CONST;
  const gitConfigPath = path.join(PROJECTS_DIR, projId, "git-config.json");
  await fs.writeJson(gitConfigPath, config, { spaces: 2 });
  return { success: true };
}

async function getGitStatus(projId) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, projId, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Project not found" };

  const proj = await fs.readJson(cfgPath);
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");
  const gitConfig = await getGitConfig(projId);

  // Check if git is initialized
  const gitDir = path.join(wwwDir, ".git");
  const hasGit = await fs.pathExists(gitDir);

  // Get default excludes/includes for this project type
  const type = proj.projectType || "php";
  const defaults = {
    excludes: DEFAULT_EXCLUDES[type] || DEFAULT_EXCLUDES.php,
    includes: DEFAULT_INCLUDES[type] || DEFAULT_INCLUDES.php,
  };

  if (!hasGit) {
    return {
      success: true,
      initialized: false,
      projectType: type,
      defaults,
      config: gitConfig,
    };
  }

  // Get git status
  const statusResult = await gitExec("git status --porcelain", wwwDir);
  const remoteResult = await gitExec("git remote -v", wwwDir);
  const branchResult = await gitExec("git branch --show-current", wwwDir);
  const logResult = await gitExec('git log --oneline -10', wwwDir);

  return {
    success: true,
    initialized: true,
    projectType: type,
    defaults,
    config: gitConfig,
    status: statusResult.output || "",
    remotes: remoteResult.output || "",
    branch: (branchResult.output || "main").trim(),
    recentCommits: logResult.output || "",
  };
}

async function gitInit(projId, { repoUrl, excludePaths, includePaths }) {
  const { PROJECTS_DIR } = global.CONST;
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");
  const cfgPath = path.join(PROJECTS_DIR, projId, "project.json");
  const proj = await fs.readJson(cfgPath);

  // Save git config
  await saveGitConfig(projId, {
    repoUrl,
    excludePaths: excludePaths || [],
    includePaths: includePaths || [],
    projectType: proj.projectType || "php",
  });

  // Write .gitignore
  const gitignoreContent = (excludePaths || []).join("\n") + "\n";
  await fs.writeFile(path.join(wwwDir, ".gitignore"), gitignoreContent);
  log.ok(`[git] .gitignore written for ${proj.name}`);

  // Init git
  let r = await gitExec("git init", wwwDir);
  if (!r.success) return { success: false, message: "git init failed: " + r.message };

  // Add remote
  if (repoUrl) {
    r = await gitExec(`git remote add origin "${repoUrl}"`, wwwDir);
    if (!r.success && !r.message?.includes("already exists")) {
      return { success: false, message: "Add remote failed: " + r.message };
    }
  }

  log.ok(`[git] Initialized for ${proj.name}`);
  return { success: true };
}

async function gitPush(projId, { message, branch }, progressCb) {
  const { PROJECTS_DIR } = global.CONST;
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");
  const gitConfig = await getGitConfig(projId);

  if (!gitConfig || !gitConfig.repoUrl) {
    return { success: false, message: "Git not configured. Set up repository URL first." };
  }

  const send = (msg) => {
    log.info(`[git] ${msg}`);
    if (progressCb) progressCb(msg);
  };

  const branchName = branch || "main";

  // Update .gitignore
  if (gitConfig.excludePaths?.length) {
    const gitignoreContent = gitConfig.excludePaths.join("\n") + "\n";
    await fs.writeFile(path.join(wwwDir, ".gitignore"), gitignoreContent);
  }

  // Check if include paths are specific subdirs (WordPress mode)
  const includes = gitConfig.includePaths || [];
  const addAll = includes.length === 0 || (includes.length === 1 && includes[0] === ".");

  send("Adding files...");
  let r;
  if (addAll) {
    r = await gitExec("git add -A", wwwDir);
  } else {
    // Add .gitignore first
    await gitExec("git add .gitignore", wwwDir);
    // Add specific paths
    for (const p of includes) {
      const fullPath = path.join(wwwDir, p);
      if (await fs.pathExists(fullPath)) {
        await gitExec(`git add "${p}"`, wwwDir);
        send(`Added: ${p}`);
      }
    }
  }

  // Check if there are changes to commit
  const statusCheck = await gitExec("git status --porcelain", wwwDir);
  const stagedCheck = await gitExec("git diff --cached --stat", wwwDir);
  if (!stagedCheck.output?.trim() && !statusCheck.output?.trim()) {
    return { success: true, message: "Nothing to commit, working tree clean." };
  }

  // Commit
  send("Committing...");
  const commitMsg = message || `Update ${new Date().toISOString().split("T")[0]}`;
  r = await gitExec(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, wwwDir);
  if (!r.success && !r.message?.includes("nothing to commit")) {
    return { success: false, message: "Commit failed: " + r.message };
  }
  send(r.output || "Committed");

  // Push
  send(`Pushing to origin/${branchName}...`);
  r = await gitExec(`git push -u origin ${branchName}`, wwwDir);
  if (!r.success) {
    // Try force push if first push
    if (r.message?.includes("rejected") || r.message?.includes("failed to push")) {
      send("First push, trying with --force...");
      r = await gitExec(`git push -u origin ${branchName} --force`, wwwDir);
    }
    if (!r.success) {
      return { success: false, message: "Push failed: " + (r.message || r.error) };
    }
  }

  send("Push complete!");
  return { success: true, message: `Pushed to origin/${branchName}`, output: r.output };
}

async function gitPull(projId, { branch }, progressCb) {
  const { PROJECTS_DIR } = global.CONST;
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");
  const gitConfig = await getGitConfig(projId);
  const branchName = branch || "main";

  const send = (msg) => {
    log.info(`[git] ${msg}`);
    if (progressCb) progressCb(msg);
  };

  send(`Pulling from origin/${branchName}...`);
  const r = await gitExec(`git pull origin ${branchName}`, wwwDir);
  if (!r.success) {
    return { success: false, message: "Pull failed: " + (r.message || r.error) };
  }
  send(r.output || "Pull complete!");
  return { success: true, message: `Pulled from origin/${branchName}`, output: r.output };
}

async function gitCloneRepo(projId, { repoUrl, branch }, progressCb) {
  const { PROJECTS_DIR } = global.CONST;
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");
  const branchName = branch || "main";

  const send = (msg) => {
    log.info(`[git] ${msg}`);
    if (progressCb) progressCb(msg);
  };

  // Empty www dir and clone into it
  send(`Cloning ${repoUrl} into project...`);
  const tmpDir = wwwDir + "_clone_tmp";
  let r = await gitExec(`git clone --branch ${branchName} "${repoUrl}" "${tmpDir}"`, path.dirname(wwwDir));
  if (!r.success) {
    await fs.remove(tmpDir).catch(() => {});
    return { success: false, message: "Clone failed: " + (r.message || r.error) };
  }

  // Move cloned content to www
  send("Moving files...");
  await fs.emptyDir(wwwDir);
  await fs.copy(tmpDir, wwwDir, { overwrite: true });
  await fs.remove(tmpDir).catch(() => {});

  send("Clone complete!");
  return { success: true, message: `Cloned from ${repoUrl}` };
}

async function gitExecCmd(projId, cmd, progressCb) {
  const { PROJECTS_DIR } = global.CONST;
  const wwwDir = path.join(PROJECTS_DIR, projId, "www");

  const send = (msg) => {
    log.info(`[git] ${msg}`);
    if (progressCb) progressCb(msg);
  };

  send(`> git ${cmd}`);
  const r = await gitExec(`git ${cmd}`, wwwDir);
  if (r.output) send(r.output);
  if (r.error && r.error !== r.output) send(r.error);
  return r;
}

module.exports = {
  DEFAULT_EXCLUDES,
  DEFAULT_INCLUDES,
  getGitStatus,
  getGitConfig,
  saveGitConfig,
  gitInit,
  gitPush,
  gitPull,
  gitCloneRepo,
  gitExecCmd,
};
