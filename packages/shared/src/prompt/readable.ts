/** A folder outside the working directory that the runner opened for reading (read-only). */
export interface ReadableFolder {
  name: string;
  path: string;
  /**
   * `project`: the chat's own project repository; `reference`: a reference repository the owner picked; `org`: another
   * repository of the organization (architect), registered or found under the organization source folder.
   */
  kind: 'project' | 'reference' | 'org';
}

/**
 * The "what you may read" section of an agent's instructions. The agent only reads what is listed; the owner manages
 * the list (Project settings, "Reference repositories"). It says so plainly so agents stop looking for, or inventing,
 * a configuration key (`repoRoots` in the runner's config only says where repositories are found and cloned).
 */
export function renderReadableFolders(folders: ReadableFolder[], opts: { workingDir?: string } = {}): string {
  const lines: string[] = ['# Folders you can read'];
  if (opts.workingDir) lines.push(`- Working directory: ${opts.workingDir}`);
  if (folders.length === 0) {
    lines.push('- No other repository is open for reading on this workstation.');
  } else {
    for (const f of folders)
      lines.push(
        `- ${f.path} (${f.kind === 'project' ? 'repository of this project' : f.kind === 'org' ? 'repository of the organization' : 'reference repository'} "${f.name}", read-only)`,
      );
  }
  lines.push(
    '',
    'Everything else on the machine is blocked, and secret files (.env, keys, certificates) are blocked even inside these folders. Read-only means you cannot edit, create or delete files there; only your working directory can change.',
    "If you need another repository, ask the manager to add it as a reference repository: the project owner does that under Project settings > Reference repositories. It is not a file or setting you can edit, so do not look for a configuration key or change the runner's config.",
  );
  return lines.join('\n');
}
