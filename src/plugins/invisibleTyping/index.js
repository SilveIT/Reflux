'use strict';

const {session} = require('electron');

// Four API prefixes ship in this fork, each with several versions; one pattern cancels nothing on
// the others — which is how this plugin used to fail silently as a no-op.
const PREFIXES = [
	'https://web.fluxer.app',
	'https://web.canary.fluxer.app',
	'https://fluxer.com',
	'https://canary.fluxer.com',
];
const VERSIONS = ['v1', 'v2', 'v10'];

const FILTER = {
	urls: PREFIXES.flatMap((prefix) =>
		VERSIONS.map((version) => `${prefix}/api/${version}/channels/*/typing`)),
};

// Belt and braces: only cancel what really is a typing request.
const TYPING_REQUEST = /\/channels\/[^/]+\/typing(?:[?#]|$)/;

let _enabled = false;

module.exports = {
	name: 'invisibleTyping',
	displayName: 'Invisible Typing',
	description: 'Prevents Fluxer from sending typing indicators to other users.',
	icon: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 256 256"><path d="M112,116a12,12,0,1,1-12-12A12,12,0,0,1,112,116Zm44-12a12,12,0,1,0,12,12A12,12,0,0,0,156,104Zm68,16v96a8,8,0,0,1-13.07,6.19l-24.26-19.85L162.4,222.19a8,8,0,0,1-10.13,0L128,202.34l-24.27,19.85a8,8,0,0,1-10.13,0L69.33,202.34,45.07,222.19A8,8,0,0,1,32,216V120a96,96,0,0,1,192,0Zm-16,0a80,80,0,0,0-160,0v79.12l16.27-13.31a8,8,0,0,1,10.13,0l24.27,19.85,24.26-19.85a8,8,0,0,1,10.14,0l24.26,19.85,24.27-19.85a8,8,0,0,1,10.13,0L208,199.12Z"/></svg>',
	rendererSrc: null,

	start() {
		_enabled = true;
		session.defaultSession.webRequest.onBeforeRequest(FILTER, (details, callback) => {
			// Cancelling needs the attached listener; the flag is what turns the plugin off again.
			callback(TYPING_REQUEST.test(details.url) ? {cancel: _enabled} : {});
		});
	},

	stop() {
		_enabled = false;
		session.defaultSession.webRequest.onBeforeRequest(FILTER, null);
	},
};
