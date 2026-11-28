'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function pngSize(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${rel} should be a valid PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('Roku channel: manifest versions align with package.json and artwork matches Roku certification dimensions', () => {
  const pkg = JSON.parse(read('package.json'));
  const [maj, min, patch] = pkg.version.split('.');
  const manifest = read('clients/roku/manifest');
  assert.match(manifest, new RegExp(`^major_version=${maj}$`, 'm'));
  assert.match(manifest, new RegExp(`^minor_version=${min}$`, 'm'));
  assert.match(manifest, new RegExp(`^build_version=${patch}$`, 'm'));
  assert.match(manifest, /^ui_resolutions=fhd$/m);
  assert.match(manifest, /^rsg_version=1\.3$/m);
  assert.match(manifest, /^supports_input_launch=1$/m);
  assert.match(manifest, /^splash_color=#0b0b0f$/m);

  assert.deepStrictEqual(pngSize('clients/roku/images/icon-focus-hd.png'), { width: 290, height: 218 });
  assert.deepStrictEqual(pngSize('clients/roku/images/icon-focus-sd.png'), { width: 246, height: 140 });
  assert.deepStrictEqual(pngSize('clients/roku/images/icon-store-540x405.png'), { width: 540, height: 405 });
  assert.deepStrictEqual(pngSize('clients/roku/images/splash-fhd.png'), { width: 1920, height: 1080 });
  assert.deepStrictEqual(pngSize('clients/roku/images/splash-hd.png'), { width: 1280, height: 720 });
  assert.deepStrictEqual(pngSize('clients/roku/images/splash-sd.png'), { width: 720, height: 480 });
});

test('Roku channel: native SceneGraph components, background Task networking, and core TV flows are complete', () => {
  const mainBrs = read('clients/roku/source/main.brs');
  assert.match(mainBrs, /CreateScene\("MainScene"\)/);
  assert.match(mainBrs, /CreateObject\("roInput"\)/);
  assert.match(mainBrs, /roInputEvent/);

  const utils = read('clients/roku/source/TriboonUtils.brs');
  assert.match(utils, /function TriboonNormalizeServerUrl\(/);
  assert.match(utils, /function TriboonRokuCaps\(/);
  assert.match(utils, /mkv:\s*false/);
  assert.match(utils, /hls:\s*true/);
  assert.match(utils, /function TriboonPreferredVodStream\(/);
  assert.match(utils, /function TriboonOrderedLiveStreams\(/);
  assert.match(utils, /roRegistrySection/);

  const apiTaskXml = read('clients/roku/components/TriboonApiTask.xml');
  const apiTaskBrs = read('clients/roku/components/TriboonApiTask.brs');
  assert.match(apiTaskXml, /<component name="TriboonApiTask" extends="Task">/);
  assert.match(apiTaskBrs, /common:\/certs\/ca-bundle\.crt/);
  assert.match(apiTaskBrs, /Authorization/);

  const sceneXml = read('clients/roku/components/MainScene.xml');
  const sceneBrs = read('clients/roku/components/MainScene.brs');
  assert.match(sceneXml, /<component name="MainScene" extends="Scene">/);
  assert.match(sceneXml, /<RowList id="browseRows"/);
  assert.match(sceneXml, /<Video id="videoPlayer"/);
  assert.match(sceneXml, /<ChannelStore id="channelStore"/);
  assert.match(sceneBrs, /signalBeacon\("AppLaunchComplete"\)/);
  assert.match(sceneBrs, /signalBeacon\("AppDialogInitiate"\)/);
  assert.match(sceneBrs, /signalBeacon\("AppDialogComplete"\)/);
  assert.match(sceneBrs, /StandardKeyboardDialog/);
  assert.match(sceneBrs, /getUserData/);
  assert.match(sceneBrs, /Left\(LCase\(rawCid\), 6\) = "local:"/);
  assert.match(sceneBrs, /handleHomeLibrariesList/);
  assert.match(sceneBrs, /q:\s*title/);
  assert.match(sceneBrs, /mediaType:\s*mType/);
  assert.match(sceneBrs, /body\.ep\s*=\s*epVal/);
  assert.match(sceneBrs, /onBrowseItemFocused/);
  assert.match(utils, /vod=1/);
  assert.match(sceneBrs, /\/api\/quickconnect/);
  assert.match(sceneBrs, /\/api\/login\/2fa/);
  assert.match(sceneBrs, /\/api\/watch\?profile=/);
  assert.match(sceneBrs, /\/api\/libraries/);
  assert.match(sceneBrs, /\/api\/iptv\/channels/);
  assert.match(sceneBrs, /\/api\/iptv\/play\//);
  assert.match(sceneBrs, /\/api\/tmdb\/search\/multi/);
  assert.match(sceneBrs, /\/api\/play/);
  assert.match(sceneBrs, /function onKeyEvent\(/);
  assert.match(sceneBrs, /sub stepLiveChannel\(/);
  assert.match(sceneBrs, /channelup/);
  assert.match(sceneBrs, /skipProfilePicker/);
  assert.match(sceneBrs, /toggle_skip_picker/);

  const posterXml = read('clients/roku/components/PosterItem.xml');
  const posterBrs = read('clients/roku/components/PosterItem.brs');
  assert.match(posterXml, /<component name="PosterItem" extends="Group">/);
  assert.match(posterBrs, /onItemContentChanged/);
});

test('Roku channel: store guide and pinned GitHub Actions packaging workflow exist', () => {
  assert.ok(fs.existsSync(path.join(root, 'clients/roku/ROKU_STORE_LISTING.md')));
  const wf = read('.github/workflows/roku.yml');
  assert.match(wf, /Triboon-Roku-v\$\{ver\}\.zip/);
  assert.match(wf, /brighterscript/);
  const usesRefs = [...wf.matchAll(/^\s*-\s+uses:\s+([^\s#]+)/gm)].map((m) => m[1]);
  assert.ok(usesRefs.length > 0);
  for (const ref of usesRefs) {
    assert.ok(/@[0-9a-f]{40}$/.test(ref), `roku.yml action pinned by full SHA: ${ref}`);
  }
});

test('Roku BrightScript: no reserved builtin identifiers (pos, eval, val, etc.) assigned as variables', () => {
  const brsFiles = [
    'clients/roku/source/main.brs',
    'clients/roku/source/TriboonUtils.brs',
    'clients/roku/components/MainScene.brs',
    'clients/roku/components/PosterItem.brs',
    'clients/roku/components/TriboonApiTask.brs',
  ];
  const reservedAssign = /^\s*(pos|eval|val|tab|rnd|stop|step|rem|dim|run)\s*=/im;
  for (const rel of brsFiles) {
    const src = read(rel);
    const m = src.match(reservedAssign);
    assert.strictEqual(m, null, `${rel} must not assign to reserved BrightScript keyword/builtin: ${m && m[0]}`);
  }
});
