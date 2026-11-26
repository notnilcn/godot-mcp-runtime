import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findSettingByPath, scanProjectFile } from './project-godot.js';

/** Where the editor keeps per-user project metadata, the "Customize Run Instances" dialog's settings among it. */
export const EDITOR_METADATA_RELATIVE_PATH = join('.godot', 'editor', 'project_metadata.cfg');

/** One row of the editor's "Customize Run Instances" dialog. */
export interface EditorRunInstance {
  arguments: string;
  features: string;
  overrideArgs: boolean;
  overrideFeatures: boolean;
}

/** The dialog's settings as the editor saved them under `[debug_options]`. */
export interface EditorRunInstancesConfig {
  multipleInstancesEnabled: boolean;
  /** `run_instance_count`; the editor runs this many when multiple instances are enabled, whatever the rows array holds. */
  instanceCount: number;
  instances: EditorRunInstance[];
  mainFeatureTags: string;
}

/** What one run instance is launched with, worked out as the editor's RunInstancesDialog does it. */
export interface RunInstanceLaunch {
  args: string[];
  featureTags: string[];
  warnings: string[];
}

/** Splits a run-arguments string as the editor's `_split_cmdline_args` does: on spaces outside `"` or `'` quotes, an escaped quote not toggling. Unlike the editor, the quote characters are removed, since the tokens go straight to the process instead of through the editor's command line. */
export function splitRunArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\' && (raw[i + 1] === '"' || raw[i + 1] === "'")) {
      current += raw[i + 1];
      hasToken = true;
      i++;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) tokens.push(current);
      current = '';
      hasToken = false;
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** The value text of `key` in `[section]` of a ConfigFile, joined across lines until its brackets balance; undefined when absent. */
function readConfigValue(content: string, section: string, key: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      inSection = header[1] === section;
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let value = line.slice(eq + 1);
    let depth = bracketDepth(value);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      value += '\n' + lines[i];
      depth = bracketDepth(value);
    }
    return value.trim();
  }
  return undefined;
}

/** Open brackets minus closed ones, outside string literals. */
function bracketDepth(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[' || ch === '(' || ch === '{') depth++;
    else if (ch === ']' || ch === ')' || ch === '}') depth--;
  }
  return depth;
}

function parseConfigString(value: string | undefined): string {
  if (value === undefined) return '';
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : '';
  } catch {
    return '';
  }
}

/** `run_instances_config=Array[Dictionary]([{...}, ...])`: the inner list is JSON-compatible for the keys and value types the editor writes. */
function parseInstanceRows(value: string | undefined): EditorRunInstance[] {
  if (value === undefined) return [];
  const open = value.indexOf('[{');
  const close = value.lastIndexOf('}]');
  if (open < 0 || close < open) return [];
  let rows: unknown;
  try {
    rows = JSON.parse(value.slice(open, close + 2));
  } catch {
    throw new Error(
      'run_instances_config in .godot/editor/project_metadata.cfg could not be read as a list of dictionaries',
    );
  }
  if (!Array.isArray(rows)) return [];
  return rows.map((row: unknown) => {
    const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
    return {
      arguments: typeof r.arguments === 'string' ? r.arguments : '',
      features: typeof r.features === 'string' ? r.features : '',
      overrideArgs: r.override_args === true,
      overrideFeatures: r.override_features === true,
    };
  });
}

/** The editor's run-instance settings for a project, or null when the editor never saved any (no metadata file, or no `run_instances_config`). @throws when the file exists and its rows cannot be read */
export function readEditorRunInstances(projectPath: string): EditorRunInstancesConfig | null {
  const file = join(projectPath, EDITOR_METADATA_RELATIVE_PATH);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf8');
  const rowsValue = readConfigValue(content, 'debug_options', 'run_instances_config');
  const countValue = readConfigValue(content, 'debug_options', 'run_instance_count');
  const enabledValue = readConfigValue(content, 'debug_options', 'multiple_instances_enabled');
  if (rowsValue === undefined && countValue === undefined && enabledValue === undefined)
    return null;
  const count = countValue === undefined ? 1 : Math.trunc(Number(countValue));
  return {
    multipleInstancesEnabled: enabledValue === 'true',
    instanceCount: Number.isFinite(count) && count >= 1 ? count : 1,
    instances: parseInstanceRows(rowsValue),
    mainFeatureTags: parseConfigString(
      readConfigValue(content, 'debug_options', 'run_main_feature_tags'),
    ),
  };
}

/** `editor/run/main_run_args` from project.godot, the "Main Run Args" every editor run starts from; '' when unset. */
export function readMainRunArgs(projectPath: string): string {
  const file = join(projectPath, 'project.godot');
  if (!existsSync(file)) return '';
  const statement = findSettingByPath(
    scanProjectFile(readFileSync(file, 'utf8')),
    'editor/run/main_run_args',
  );
  return typeof statement?.value === 'string' ? statement.value : '';
}

function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** How the editor launches run instance `index` (`RunInstancesDialog::get_argument_list_for_instance` and `apply_custom_features`): the main run args, then the instance's own unless it overrides them; with multiple instances disabled, the main args alone. A `%command%` wrapper is not run: only the arguments after it are kept, with a warning. */
export function resolveRunInstanceLaunch(
  index: number,
  config: EditorRunInstancesConfig | null,
  mainRunArgs: string,
): RunInstanceLaunch {
  const warnings: string[] = [];
  const multi = config?.multipleInstancesEnabled === true;
  const row = multi ? config?.instances[index] : undefined;
  if (config !== null && multi && index >= config.instanceCount) {
    warnings.push(
      `The editor runs ${config.instanceCount} instance(s) (Debug > Customize Run Instances); instance ${index} is beyond that, so it was launched with ${row !== undefined ? 'its saved row' : 'the main run args only'}.`,
    );
  } else if (config !== null && !multi && index > 0) {
    warnings.push(
      'Multiple instances are disabled in the editor (Debug > Customize Run Instances), so this instance was launched with the main run args only, as the editor would.',
    );
  }

  let raw: string;
  if (row === undefined) raw = mainRunArgs;
  else if (row.overrideArgs) raw = row.arguments;
  else raw = [mainRunArgs, row.arguments].filter((part) => part.trim() !== '').join(' ');

  const placeholder = raw.indexOf('%command%');
  if (placeholder >= 0) {
    warnings.push(
      'The run arguments contain a %command% wrapper; the wrapper was not run, only the arguments after %command% were passed to Godot.',
    );
    raw = raw.slice(placeholder + '%command%'.length);
  }

  const mainTags = config?.mainFeatureTags ?? '';
  const featureText =
    row === undefined
      ? mainTags
      : row.overrideFeatures
        ? row.features
        : `${mainTags},${row.features}`;
  return { args: splitRunArgs(raw), featureTags: splitTags(featureText), warnings };
}
