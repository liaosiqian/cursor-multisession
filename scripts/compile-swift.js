const fs = require('fs');
const cp = require('child_process');
const path = require('path');

if (process.platform !== 'darwin') {
	console.log('skip swift (not macOS)');
	process.exit(0);
}

const builds = [
	{
		src: 'scripts/capture-cursor.swift',
		bin: 'scripts/capture-cursor',
		flags: '-framework ScreenCaptureKit -framework AppKit -framework CoreGraphics',
	},
	{
		src: 'scripts/record.swift',
		bin: 'scripts/record',
		flags: '-framework AVFoundation',
	},
	{
		src: 'scripts/transcribe.swift',
		bin: 'scripts/transcribe',
		flags: '-framework Speech -framework AVFoundation',
	},
];

for (const { src, bin, flags } of builds) {
	if (!fs.existsSync(src)) {
		console.log(`skip ${src} (not found)`);
		continue;
	}
	if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) {
		console.log(`${path.basename(bin)} up-to-date`);
		continue;
	}
	console.log(`compiling ${src}...`);
	cp.execSync(`swiftc ${src} -o ${bin} ${flags}`, { stdio: 'inherit' });
	console.log(`${path.basename(bin)} rebuilt`);
}
