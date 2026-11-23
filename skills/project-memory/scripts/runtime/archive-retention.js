'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ARCHIVE_SCHEMA, ARCHIVE_GENERATOR, ARCHIVE_MANIFEST_FILE, TEXT_EXTENSIONS } = require('./constants');
const { fail } = require('./errors');
const { fs, path, readText, writeJsonAtomic, existingFile, toProjectPath, ensureSafeDirectory, assertSafeExistingDirectory, assertSafeProjectFile, runtimePaths } = require('./filesystem');
const { isSafeTaskId, taskDirectory, taskPathForManagedFile, readTaskManifest, refreshTaskManifest, inspectManagedTaskFiles, safeManagedTaskFilename } = require('./tasks');

function isoWeek(date) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isNaN(timestamp) ? null : timestamp;
}

function fileMetadata(filePath) {
  if (!existingFile(filePath)) {
    return null;
  }
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    let bytesRead;
    do {
      bytesRead = fs.readSync(handle, buffer, 0, buffer.length, position);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(handle);
  }
  return { sha256: hash.digest('hex'), size: fs.statSync(filePath).size };
}

function sameMetadata(left, right) {
  return Boolean(left && right && left.sha256 === right.sha256 && left.size === right.size);
}

function archiveManifestMatchesZip(manifest, zipPath) {
  if (!manifest || !manifest.zip || typeof manifest.zip.sha256 !== 'string' || !Number.isSafeInteger(manifest.zip.size) || manifest.zip.size < 0) {
    return false;
  }
  try {
    const actual = fileMetadata(zipPath);
    return sameMetadata(actual, manifest.zip);
  } catch (error) {
    return false;
  }
}

function validArchiveFileMetadata(task) {
  if (!task.file_metadata || Array.isArray(task.file_metadata) || typeof task.file_metadata !== 'object') {
    return false;
  }
  const names = Object.keys(task.file_metadata);
  return names.length === task.files.length && task.files.every((fileName) => {
    const metadata = task.file_metadata[fileName];
    return metadata && typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(metadata.sha256) && Number.isSafeInteger(metadata.size) && metadata.size >= 0;
  });
}

function validArchiveTask(task) {
  const activityAt = task && (task.activity_at || task.terminal_at);
  return task && isSafeTaskId(task.task_id) && typeof activityAt === 'string' && parseTimestamp(activityAt) !== null && typeof task.archived_at === 'string' && Array.isArray(task.files) && task.files.length > 0 && task.files.length === new Set(task.files).size && task.files.every((fileName) => safeManagedTaskFilename(fileName) && TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase())) && validArchiveFileMetadata(task);
}

function readArchiveManifest(projectRoot, manifestPath, week) {
  if (!existingFile(manifestPath)) {
    return null;
  }
  try {
    assertSafeProjectFile(projectRoot, manifestPath, true);
    const manifest = JSON.parse(readText(manifestPath));
    const expectedZipName = `project-memory-${week}.zip`;
    if (manifest.schema !== ARCHIVE_SCHEMA || manifest.kind !== 'project-memory-weekly-archive' || manifest.generator !== ARCHIVE_GENERATOR || manifest.week !== week || !manifest.zip || manifest.zip.name !== expectedZipName || typeof manifest.zip.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.zip.sha256) || !Number.isSafeInteger(manifest.zip.size) || manifest.zip.size < 1 || !Array.isArray(manifest.tasks) || manifest.tasks.some((task) => !validArchiveTask(task))) {
      return null;
    }
    return manifest;
  } catch (error) {
    return null;
  }
}

function archiveBucket(projectRoot, week) {
  const paths = runtimePaths(projectRoot);
  const directory = path.join(paths.archives, week);
  const zipName = `project-memory-${week}.zip`;
  return { directory, manifestPath: path.join(directory, ARCHIVE_MANIFEST_FILE), zipPath: path.join(directory, zipName), zipName };
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function copyTaskTextToStaging(projectRoot, taskDirectoryPath, stagingTaskPath, managedFiles) {
  ensureSafeDirectory(projectRoot, stagingTaskPath);
  assertSafeExistingDirectory(projectRoot, taskDirectoryPath);
  const files = [];
  const metadata = {};
  for (const fileName of managedFiles) {
    if (!TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      continue;
    }
    const source = taskPathForManagedFile(taskDirectoryPath, fileName);
    if (!existingFile(source)) {
      fail(`受管任务文件缺失：${source}`);
    }
    assertSafeProjectFile(projectRoot, source, true);
    const sourceBeforeCopy = fileMetadata(source);
    const target = path.join(stagingTaskPath, fileName);
    ensureSafeDirectory(projectRoot, path.dirname(target));
    assertSafeProjectFile(projectRoot, target, false);
    fs.copyFileSync(source, target);
    const copiedMetadata = fileMetadata(target);
    const sourceAfterCopy = fileMetadata(source);
    if (!sameMetadata(sourceBeforeCopy, sourceAfterCopy) || !sameMetadata(copiedMetadata, sourceAfterCopy)) {
      fail(`归档复制期间受管任务文件发生变化：${source}`);
    }
    files.push(fileName);
    metadata[fileName] = copiedMetadata;
  }
  return { files: files.sort(), file_metadata: metadata };
}

function compressStagingDirectory(stagingRootPath, zipPath) {
  const command = `Compress-Archive -Path ${quotePowerShell(path.join(stagingRootPath, '*'))} -DestinationPath ${quotePowerShell(zipPath)}`;
  execFileSync('powershell', ['-Command', command], { stdio: 'pipe' });
}

function copyExistingArchiveToStaging(bucket, stagingRootPath) {
  if (!existingFile(bucket.zipPath)) {
    return;
  }
  const command = `Expand-Archive -LiteralPath ${quotePowerShell(bucket.zipPath)} -DestinationPath ${quotePowerShell(stagingRootPath)} -Force`;
  execFileSync('powershell', ['-Command', command], { stdio: 'pipe' });
}

function removeStagingArtifacts(stagingRootPath, stagedZipPath) {
  const failures = [];
  const remove = (label, target, recursive) => {
    if (!fs.existsSync(target)) {
      return;
    }
    try {
      if (recursive) {
        fs.rmSync(target, { recursive: true, force: false });
      } else {
        fs.unlinkSync(target);
      }
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  };
  remove('staged ZIP cleanup', stagedZipPath, false);
  remove('staging directory cleanup', stagingRootPath, true);
  return failures;
}

function removeEmptyCreatedBucket(bucket) {
  if (!fs.existsSync(bucket.directory)) {
    return null;
  }
  try {
    if (fs.readdirSync(bucket.directory).length === 0) {
      fs.rmdirSync(bucket.directory);
      return null;
    }
    return 'bucket contains files after failed replacement';
  } catch (error) {
    return error.message;
  }
}

function taskDirectoryIsRemovable(projectRoot, candidate, expectedFileMetadata) {
  assertSafeExistingDirectory(projectRoot, candidate.directory);
  const current = readTaskManifest(projectRoot, candidate.taskId);
  if (!current || current.last_activity_at !== candidate.manifest.last_activity_at || JSON.stringify(current.managed_files) !== JSON.stringify(candidate.manifest.managed_files)) {
    return { ok: false, reason: 'task_manifest_changed_since_selection' };
  }
  const inspected = inspectManagedTaskFiles(projectRoot, candidate.taskId);
  if (inspected.unknown.length > 0) {
    return { ok: false, reason: 'task_contains_unmanaged_files_before_cleanup', files: inspected.unknown };
  }
  const discoveredFiles = ['task.json', ...inspected.files].sort();
  const managedFiles = [...candidate.manifest.managed_files].sort();
  if (JSON.stringify(discoveredFiles) !== JSON.stringify(managedFiles)) {
    return { ok: false, reason: 'task_files_changed_since_selection' };
  }
  if (expectedFileMetadata) {
    for (const [fileName, expected] of Object.entries(expectedFileMetadata)) {
      const source = taskPathForManagedFile(candidate.directory, fileName);
      if (!existingFile(source)) {
        return { ok: false, reason: 'task_file_changed_before_cleanup', file: fileName };
      }
      const actual = fileMetadata(source);
      if (!sameMetadata(actual, expected)) {
        return { ok: false, reason: 'task_file_changed_before_cleanup', file: fileName };
      }
    }
  }
  return { ok: true };
}

function removeTaskDirectory(projectRoot, candidate, expectedFileMetadata) {
  try {
    const removable = taskDirectoryIsRemovable(projectRoot, candidate, expectedFileMetadata);
    if (!removable.ok) {
      return removable;
    }
    fs.rmSync(candidate.directory, { recursive: true, force: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `source_cleanup_failed: ${error.message}` };
  }
}

function archiveTaskMatchesCandidate(projectRoot, bucket, candidate) {
  const manifest = readArchiveManifest(projectRoot, bucket.manifestPath, path.basename(bucket.directory));
  if (!manifest || !existingFile(bucket.zipPath) || !archiveManifestMatchesZip(manifest, bucket.zipPath)) {
    return false;
  }
  return manifest.tasks.some((task) => task.task_id === candidate.taskId && (task.activity_at || task.terminal_at) === candidate.manifest.last_activity_at && JSON.stringify(task.files) === JSON.stringify(candidate.manifest.managed_files.filter((fileName) => TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase())).sort()) && task.file_metadata && task.files.every((fileName) => {
    const current = taskPathForManagedFile(candidate.directory, fileName);
    const recorded = task.file_metadata[fileName];
    return existingFile(current) && sameMetadata(fileMetadata(current), recorded);
  }));
}

function replacementBackupPath(filePath, stamp) {
  return `${filePath}.replace-${stamp}`;
}

function isGeneratedReplacementBackup(name, bucket) {
  const zipPrefix = `${bucket.zipName}.replace-`;
  const manifestPrefix = `${ARCHIVE_MANIFEST_FILE}.replace-`;
  return (name.startsWith(zipPrefix) || name.startsWith(manifestPrefix)) && /^.+\.replace-[0-9]+-[0-9]+$/.test(name);
}

function generatedReplacementBackups(bucket) {
  if (!fs.existsSync(bucket.directory)) {
    return [];
  }
  return fs.readdirSync(bucket.directory, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.isSymbolicLink() && isGeneratedReplacementBackup(entry.name, bucket)).map((entry) => entry.name).sort();
}

function cleanupReplacementBackupPaths(paths) {
  const failures = [];
  for (const backupPath of paths.filter(Boolean)) {
    if (!fs.existsSync(backupPath)) {
      continue;
    }
    try {
      fs.unlinkSync(backupPath);
    } catch (error) {
      failures.push(`${path.basename(backupPath)}: ${error.message}`);
    }
  }
  return failures;
}

function replaceArchiveBucket(bucket, stagedZipPath, stagedManifestPath, zipExists, manifestExists) {
  const stamp = `${process.pid}-${Date.now()}`;
  const backupZipPath = zipExists ? replacementBackupPath(bucket.zipPath, stamp) : null;
  const backupManifestPath = manifestExists ? replacementBackupPath(bucket.manifestPath, stamp) : null;
  let movedZip = false;
  let movedManifest = false;
  let placedZip = false;
  let placedManifest = false;
  try {
    if (backupZipPath) {
      fs.renameSync(bucket.zipPath, backupZipPath);
      movedZip = true;
    }
    if (backupManifestPath) {
      fs.renameSync(bucket.manifestPath, backupManifestPath);
      movedManifest = true;
    }
    fs.renameSync(stagedZipPath, bucket.zipPath);
    placedZip = true;
    fs.renameSync(stagedManifestPath, bucket.manifestPath);
    placedManifest = true;
  } catch (error) {
    const recoveryFailures = [];
    const attempt = (label, action) => {
      try {
        action();
      } catch (recoveryError) {
        recoveryFailures.push(`${label}: ${recoveryError.message}`);
      }
    };
    if (placedManifest && fs.existsSync(bucket.manifestPath)) {
      attempt('remove newly placed manifest', () => fs.unlinkSync(bucket.manifestPath));
    }
    if (placedZip && fs.existsSync(bucket.zipPath)) {
      attempt('remove newly placed ZIP', () => fs.unlinkSync(bucket.zipPath));
    }
    if (movedManifest && backupManifestPath && fs.existsSync(backupManifestPath) && !fs.existsSync(bucket.manifestPath)) {
      attempt('restore previous manifest', () => fs.renameSync(backupManifestPath, bucket.manifestPath));
    }
    if (movedZip && backupZipPath && fs.existsSync(backupZipPath) && !fs.existsSync(bucket.zipPath)) {
      attempt('restore previous ZIP', () => fs.renameSync(backupZipPath, bucket.zipPath));
    }
    if (recoveryFailures.length > 0) {
      error.message = `${error.message} Archive replacement recovery incomplete: ${recoveryFailures.join('; ')}`;
    }
    throw error;
  }
  return { backup_cleanup_failures: cleanupReplacementBackupPaths([backupZipPath, backupManifestPath]) };
}

function taskArchiveCandidates(projectRoot) {
  const paths = runtimePaths(projectRoot);
  if (!fs.existsSync(paths.temp)) {
    return { candidates: [], skipped: [] };
  }
  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const candidates = [];
  const skipped = [];
  for (const entry of fs.readdirSync(paths.temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'archives') {
      continue;
    }
    if (!isSafeTaskId(entry.name)) {
      skipped.push({ path: toProjectPath(projectRoot, path.join(paths.temp, entry.name)), reason: 'unknown_task_directory' });
      continue;
    }
    const taskPath = path.join(paths.temp, entry.name);
    try {
      assertSafeExistingDirectory(projectRoot, taskPath);
    } catch (error) {
      skipped.push({ path: toProjectPath(projectRoot, taskPath), reason: `unsafe_task_directory: ${error.message}` });
      continue;
    }
    let manifest;
    try {
      manifest = refreshTaskManifest(projectRoot, entry.name).manifest;
    } catch (error) {
      skipped.push({ path: toProjectPath(projectRoot, taskPath), reason: `invalid_task_manifest: ${error.message}` });
      continue;
    }
    if (!manifest) {
      skipped.push({ path: toProjectPath(projectRoot, taskPath), reason: 'missing_or_invalid_task_manifest' });
      continue;
    }
    const activityAt = parseTimestamp(manifest.last_activity_at);
    if (activityAt === null || activityAt > cutoff) {
      continue;
    }
    const inspected = inspectManagedTaskFiles(projectRoot, entry.name);
    if (inspected.unknown.length > 0) {
      skipped.push({ path: toProjectPath(projectRoot, taskPath), reason: 'task_contains_unmanaged_files', files: inspected.unknown });
      continue;
    }
    candidates.push({ taskId: entry.name, directory: taskPath, manifest, activityAt });
  }
  return { candidates, skipped };
}

function rotate(projectRoot) {
  const paths = runtimePaths(projectRoot);
  ensureSafeDirectory(projectRoot, paths.runtime);
  ensureSafeDirectory(projectRoot, paths.temp);
  const selection = taskArchiveCandidates(projectRoot);
  if (selection.candidates.length === 0) {
    return { status: 'nothing_to_rotate', skipped: selection.skipped };
  }
  ensureSafeDirectory(projectRoot, paths.archives);
  ensureSafeDirectory(projectRoot, paths.staging);
  const archived = [];
  const skipped = [...selection.skipped];
  for (const candidate of selection.candidates) {
    const week = isoWeek(new Date(candidate.activityAt));
    const bucket = archiveBucket(projectRoot, week);
    const bucketExists = fs.existsSync(bucket.directory);
    if (bucketExists) {
      try {
        assertSafeExistingDirectory(projectRoot, bucket.directory);
      } catch (error) {
        skipped.push({ task: candidate.taskId, reason: `unsafe_archive_bucket: ${error.message}`, bucket: toProjectPath(projectRoot, bucket.directory) });
        continue;
      }
    }
    let manifest = readArchiveManifest(projectRoot, bucket.manifestPath, week);
    const zipExists = existingFile(bucket.zipPath);
    if (zipExists) {
      try {
        assertSafeProjectFile(projectRoot, bucket.zipPath, true);
      } catch (error) {
        skipped.push({ task: candidate.taskId, reason: `unsafe_archive_zip: ${error.message}`, bucket: toProjectPath(projectRoot, bucket.directory) });
        continue;
      }
    }
    if (bucketExists && (!manifest || !zipExists || !archiveManifestMatchesZip(manifest, bucket.zipPath))) {
      skipped.push({ task: candidate.taskId, reason: 'unknown_or_incomplete_archive_bucket', bucket: toProjectPath(projectRoot, bucket.directory) });
      continue;
    }
    if (bucketExists && !bucketHasOnlyGeneratedFiles(bucket)) {
      skipped.push({ task: candidate.taskId, reason: 'bucket_contains_unknown_files', bucket: toProjectPath(projectRoot, bucket.directory) });
      continue;
    }
    if (!manifest) {
      manifest = { schema: ARCHIVE_SCHEMA, kind: 'project-memory-weekly-archive', generator: ARCHIVE_GENERATOR, week, created_at: new Date().toISOString(), tasks: [] };
    }
    if (manifest.tasks.some((task) => task.task_id === candidate.taskId)) {
      if (!archiveTaskMatchesCandidate(projectRoot, bucket, candidate)) {
        skipped.push({ task: candidate.taskId, reason: 'archive_task_conflict', bucket: toProjectPath(projectRoot, bucket.directory) });
        continue;
      }
      const cleanup = removeTaskDirectory(projectRoot, candidate, manifest.tasks.find((task) => task.task_id === candidate.taskId).file_metadata);
      if (cleanup.ok) {
        archived.push({ task: candidate.taskId, archive: toProjectPath(projectRoot, bucket.zipPath), source_cleanup: 'retried' });
      } else {
        skipped.push({ task: candidate.taskId, reason: cleanup.reason, files: cleanup.files, archive: toProjectPath(projectRoot, bucket.zipPath) });
      }
      continue;
    }
    const stagingRootPath = path.join(paths.staging, `${week}-${candidate.taskId}-${process.pid}-${Date.now()}`);
    const stagingContentPath = path.join(stagingRootPath, 'content');
    const stagingTaskPath = path.join(stagingContentPath, candidate.taskId);
    const stagingId = `${week}-${candidate.taskId}-${process.pid}-${Date.now()}`;
    const stagedZipPath = path.join(paths.staging, `${stagingId}.zip`);
    const stagedManifestPath = path.join(stagingRootPath, ARCHIVE_MANIFEST_FILE);
    if (fs.existsSync(stagingRootPath)) {
      skipped.push({ task: candidate.taskId, reason: 'staging_path_already_exists', staging: toProjectPath(projectRoot, stagingRootPath) });
      continue;
    }
    ensureSafeDirectory(projectRoot, stagingRootPath);
    ensureSafeDirectory(projectRoot, stagingContentPath);
    let files;
    let fileMetadataByName;
    try {
      copyExistingArchiveToStaging(bucket, stagingContentPath);
      const stagedTask = copyTaskTextToStaging(projectRoot, candidate.directory, stagingTaskPath, candidate.manifest.managed_files);
      files = stagedTask.files;
      fileMetadataByName = stagedTask.file_metadata;
    } catch (error) {
      const stagingFailures = removeStagingArtifacts(stagingRootPath, stagedZipPath);
      skipped.push({ task: candidate.taskId, reason: `staging_failed: ${error.message}`, ...(stagingFailures.length > 0 ? { staging_cleanup_failures: stagingFailures } : {}) });
      continue;
    }
    if (files.length === 0) {
      const stagingFailures = removeStagingArtifacts(stagingRootPath, stagedZipPath);
      skipped.push({ task: candidate.taskId, reason: 'no_text_files_to_archive', ...(stagingFailures.length > 0 ? { staging_cleanup_failures: stagingFailures } : {}) });
      continue;
    }
    let sourceCleanup;
    let archiveCommitted = false;
    try {
      compressStagingDirectory(stagingContentPath, stagedZipPath);
      const zip = fileMetadata(stagedZipPath);
      if (!zip || zip.size < 1) {
        fail('生成的 ZIP 归档为空或不可读。');
      }
      manifest.tasks.push({ task_id: candidate.taskId, activity_at: candidate.manifest.last_activity_at, archived_at: new Date().toISOString(), files, file_metadata: fileMetadataByName });
      manifest.zip = { name: bucket.zipName, sha256: zip.sha256, size: zip.size };
      manifest.updated_at = new Date().toISOString();
      writeJsonAtomic(stagedManifestPath, manifest);
      if (!bucketExists) {
        ensureSafeDirectory(projectRoot, bucket.directory);
      }
      const replacement = replaceArchiveBucket(bucket, stagedZipPath, stagedManifestPath, zipExists, existingFile(bucket.manifestPath));
      archiveCommitted = true;
      sourceCleanup = removeTaskDirectory(projectRoot, candidate, fileMetadataByName);
      const cleanupFailure = sourceCleanup.ok ? null : { reason: sourceCleanup.reason, files: sourceCleanup.files };
      const stagingFailures = removeStagingArtifacts(stagingRootPath, stagedZipPath);
      archived.push({ task: candidate.taskId, archive: toProjectPath(projectRoot, bucket.zipPath), source_cleanup: sourceCleanup.ok ? 'completed' : 'pending', ...(cleanupFailure ? { cleanup_failure: cleanupFailure } : {}), ...(stagingFailures.length > 0 ? { staging_cleanup_failures: stagingFailures } : {}), ...(replacement.backup_cleanup_failures.length > 0 ? { replacement_backup_cleanup_failures: replacement.backup_cleanup_failures } : {}) });
    } catch (error) {
      const stagingFailures = removeStagingArtifacts(stagingRootPath, stagedZipPath);
      if (archiveCommitted) {
        skipped.push({ task: candidate.taskId, reason: `archive_committed_source_cleanup_failed: ${error.message}`, archive: toProjectPath(projectRoot, bucket.zipPath), ...(stagingFailures.length > 0 ? { staging_cleanup_failures: stagingFailures } : {}) });
        continue;
      }
      const bucketCleanupFailure = !bucketExists ? removeEmptyCreatedBucket(bucket) : null;
      skipped.push({ task: candidate.taskId, reason: `archive_failed: ${error.message}`, ...(bucketCleanupFailure ? { bucket_cleanup_failure: bucketCleanupFailure } : {}), ...(stagingFailures.length > 0 ? { staging_cleanup_failures: stagingFailures } : {}) });
    }
  }
  return { status: archived.length > 0 ? 'rotated' : 'nothing_rotated', archives: archived, skipped };
}

function validIsoWeek(week) {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53) {
    return false;
  }
  return number <= Number(isoWeek(new Date(year, 11, 28)).slice(-2));
}

function weekSortValue(week) {
  const match = week.match(/^(\d{4})-W(\d{2})$/);
  return match ? (Number(match[1]) * 100) + Number(match[2]) : -1;
}

function bucketHasOnlyGeneratedFiles(bucket) {
  return fs.readdirSync(bucket.directory, { withFileTypes: true }).every((entry) => entry.isFile() && !entry.isSymbolicLink() && (entry.name === ARCHIVE_MANIFEST_FILE || entry.name === bucket.zipName || isGeneratedReplacementBackup(entry.name, bucket)));
}

function cleanup(projectRoot) {
  const paths = runtimePaths(projectRoot);
  if (!fs.existsSync(paths.archives)) {
    return { status: 'nothing_to_cleanup' };
  }
  assertSafeExistingDirectory(projectRoot, paths.archives);
  const known = [];
  const skipped = [];
  for (const entry of fs.readdirSync(paths.archives, { withFileTypes: true })) {
    if (entry.name === '.staging' && entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      skipped.push({ path: toProjectPath(projectRoot, path.join(paths.archives, entry.name)), reason: 'unknown_archive_entry' });
      continue;
    }
    if (!validIsoWeek(entry.name)) {
      skipped.push({ path: toProjectPath(projectRoot, path.join(paths.archives, entry.name)), reason: 'unknown_archive_bucket' });
      continue;
    }
    const bucket = archiveBucket(projectRoot, entry.name);
    try {
      assertSafeExistingDirectory(projectRoot, bucket.directory);
    } catch (error) {
      skipped.push({ path: toProjectPath(projectRoot, bucket.directory), reason: `unsafe_archive_bucket: ${error.message}` });
      continue;
    }
    const manifest = readArchiveManifest(projectRoot, bucket.manifestPath, entry.name);
    if (!manifest || !existingFile(bucket.zipPath) || !archiveManifestMatchesZip(manifest, bucket.zipPath)) {
      skipped.push({ path: toProjectPath(projectRoot, bucket.directory), reason: 'unknown_or_incomplete_archive_bucket' });
      continue;
    }
    if (!bucketHasOnlyGeneratedFiles(bucket)) {
      skipped.push({ path: toProjectPath(projectRoot, bucket.directory), reason: 'bucket_contains_unknown_files' });
      continue;
    }
    const backups = generatedReplacementBackups(bucket);
    if (backups.length > 0) {
      skipped.push({ path: toProjectPath(projectRoot, bucket.directory), reason: 'replacement_backups_present', files: backups });
      continue;
    }
    known.push(bucket);
  }
  known.sort((left, right) => weekSortValue(path.basename(right.directory)) - weekSortValue(path.basename(left.directory)));
  const expired = known.slice(7);
  const deleted = [];
  const deletionFailures = [];
  for (const bucket of expired) {
    try {
      fs.unlinkSync(bucket.zipPath);
      fs.unlinkSync(bucket.manifestPath);
      fs.rmdirSync(bucket.directory);
      deleted.push(toProjectPath(projectRoot, bucket.directory));
    } catch (error) {
      deletionFailures.push({ path: toProjectPath(projectRoot, bucket.directory), reason: `archive_deletion_failed: ${error.message}` });
    }
  }
  return { status: deleted.length > 0 ? 'cleaned' : 'nothing_to_cleanup', deleted, retained_weeks: known.slice(0, 7).map((bucket) => path.basename(bucket.directory)), skipped: skipped.concat(deletionFailures) };
}

module.exports = { rotate, cleanup };
