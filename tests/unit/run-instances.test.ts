import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  readEditorRunInstances,
  readMainRunArgs,
  resolveRunInstanceLaunch,
  splitRunArgs,
  type EditorRunInstancesConfig,
} from '../../src/utils/run-instances.js';
import { useTmpDirs } from '../helpers/tmp.js';

const tmp = useTmpDirs();

/** The shape the 4.x editor writes for Debug > Customize Run Instances. */
const METADATA = `[game_view]

select_mode=0

[debug_options]

run_instances_config=Array[Dictionary]([{
"arguments": "-- --pixelize=perspective --token=SECRET",
"features": "",
"override_args": false,
"override_features": false
}, {
"arguments": "-- --p1 --name=\\"Alice Smith\\"",
"features": "red,blue",
"override_args": true,
"override_features": false
}, {
"arguments": "",
"features": "",
"override_args": false,
"override_features": false
}])
run_instance_count=2.0
run_main_feature_tags="main"
multiple_instances_enabled=true

[recent_files]

scenes=["res://main.tscn"]
`;

function projectWith(metadata: string | null, projectGodot = 'config_version=5\n'): string {
  const dir = tmp.makeProject('godot-mcp-run-instances-');
  writeFileSync(join(dir, 'project.godot'), projectGodot, 'utf8');
  if (metadata !== null) {
    mkdirSync(join(dir, '.godot', 'editor'), { recursive: true });
    writeFileSync(join(dir, '.godot', 'editor', 'project_metadata.cfg'), metadata, 'utf8');
  }
  return dir;
}

describe('splitRunArgs', () => {
  it('splits on spaces outside quotes and drops the quote characters', () => {
    expect(splitRunArgs('  -- --a=1   "two words" \'x y\' --n=\\"q\\" ')).toEqual([
      '--',
      '--a=1',
      'two words',
      'x y',
      '--n="q"',
    ]);
    expect(splitRunArgs('')).toEqual([]);
    expect(splitRunArgs('""')).toEqual(['']);
  });
});

describe('readEditorRunInstances', () => {
  it('reads the rows, the count and the switches the editor saved', () => {
    const config = readEditorRunInstances(projectWith(METADATA));
    expect(config).toEqual({
      multipleInstancesEnabled: true,
      instanceCount: 2,
      mainFeatureTags: 'main',
      instances: [
        {
          arguments: '-- --pixelize=perspective --token=SECRET',
          features: '',
          overrideArgs: false,
          overrideFeatures: false,
        },
        {
          arguments: '-- --p1 --name="Alice Smith"',
          features: 'red,blue',
          overrideArgs: true,
          overrideFeatures: false,
        },
        { arguments: '', features: '', overrideArgs: false, overrideFeatures: false },
      ],
    });
  });

  it('is null when the editor saved nothing', () => {
    expect(readEditorRunInstances(projectWith(null))).toBeNull();
    expect(readEditorRunInstances(projectWith('[game_view]\n\nselect_mode=0\n'))).toBeNull();
  });
});

describe('resolveRunInstanceLaunch', () => {
  const config = (overrides: Partial<EditorRunInstancesConfig> = {}): EditorRunInstancesConfig => ({
    ...readEditorRunInstances(projectWith(METADATA))!,
    ...overrides,
  });

  it("appends an instance's arguments to the main run args unless it overrides them", () => {
    expect(resolveRunInstanceLaunch(0, config(), '--verbose')).toEqual({
      args: ['--verbose', '--', '--pixelize=perspective', '--token=SECRET'],
      featureTags: ['main'],
      warnings: [],
    });
    expect(resolveRunInstanceLaunch(1, config(), '--verbose')).toEqual({
      args: ['--', '--p1', '--name=Alice Smith'],
      featureTags: ['main', 'red', 'blue'],
      warnings: [],
    });
  });

  it('uses the main run args alone, with a warning, when multiple instances are disabled', () => {
    const launch = resolveRunInstanceLaunch(1, config({ multipleInstancesEnabled: false }), '');
    expect(launch.args).toEqual([]);
    expect(launch.warnings[0]).toMatch(/Multiple instances are disabled/);
  });

  it('warns for an instance beyond the count the editor runs', () => {
    const launch = resolveRunInstanceLaunch(2, config(), '');
    expect(launch.args).toEqual([]);
    expect(launch.warnings[0]).toMatch(/runs 2 instance/);
  });

  it('keeps only the arguments after a %command% wrapper', () => {
    const launch = resolveRunInstanceLaunch(0, null, 'prime-run %command% --x');
    expect(launch.args).toEqual(['--x']);
    expect(launch.warnings[0]).toMatch(/%command%/);
  });
});

describe('readMainRunArgs', () => {
  it('reads editor/run/main_run_args from project.godot', () => {
    const dir = projectWith(
      null,
      'config_version=5\n\n[editor]\n\nrun/main_run_args="--a -- --b"\n',
    );
    expect(readMainRunArgs(dir)).toBe('--a -- --b');
    expect(readMainRunArgs(projectWith(null))).toBe('');
  });
});
