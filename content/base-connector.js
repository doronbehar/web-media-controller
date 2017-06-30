'use strict';

/* exported BaseConnector */

const BaseConnector = (() => {
    const ids = new WeakMap();
    const lastValue = new WeakMap();
    const lastCallTime = new WeakMap();
    const propertyNames = [
        'properties',
        'playbackStatus',
        'trackInfo',
        'volume',
        'currentTime',
    ];
    const throttleInterval = { currentTime: 2000 };
    const port = new WeakMap();
    const prefix = new WeakMap();
    const displayedWarnings = new WeakMap();

    class BaseConnector {
        /**
         * @constructor
         * Initializes base for all connectors
         */
        constructor() {
            this.name = 'Web Media Controller';

            this.playButtonSelector = null;
            this.stopButtonSelector = null;
            this.prevButtonSelector = null;
            this.nextButtonSelector = null;
            this.artistSelector = null;
            this.artistsSelector = null;
            this.albumSelector = null;
            this.titleSelector = null;
            this.artSelector = null;
            this.progressSelector = null;
            this.volumeSelector = null;

            this.pageGetters = new Set();
            this.pageSetters = new Set();
            this.pageActions = new Set();

            displayedWarnings.set(this, new Set());
            ids.set(this, new Map());
            lastValue.set(this, new Map([
                ['playbackStatus', 'stopped'],
            ]));
            lastCallTime.set(this, new Map());
            prefix.set(this, '/me/f1u77y/web_media_controller');

            port.set(this, chrome.runtime.connect());
            port.get(this).onMessage.addListener((message) => {
                switch (message.command) {
                case 'play':
                    this.play();
                    break;
                case 'pause':
                    this.pause();
                    break;
                case 'playPause':
                    this.playPause();
                    break;
                case 'stop':
                    this.stop();
                    break;
                case 'previous':
                    this.previous();
                    break;
                case 'next':
                    this.next();
                    break;
                case 'seek':
                    this.seek(message.argument);
                    break;
                case 'setPosition':
                    this.position = message.argument;
                    break;
                case 'volume':
                    this.volume = message.argument;
                    break;

                case 'reload':
                    for (let name of propertyNames) {
                        if (lastValue.get(this).has(name)) {
                            this.sendProperty(name, lastValue.get(this).get(name));
                        }
                    }
                    this.sendProperty('name', this.name);
                    break;
                }

                return false;
            });
        }

        /**
         * Add parameter to the connector object prefix. Should be called exactly one time!
         * @param {string} prefix - Connector's prefix. In most cases should be derived from domain
         */
        set prefix(addedPrefix) {
            prefix.set(this, `${prefix.get(this)}${addedPrefix}`);
        }

        /**
         * Send updated property to the background. Intended for internal usage
         * @param {string} name - Property name
         * @param {object} value - New property value
         * @param {object} message - First parameter can be object of { name, value }
         */
        sendProperty(name, value) {
            let message = name;
            if (typeof name === 'string') {
                message = { name, value };
            }
            if (message.name === 'trackInfo') {
                message.value = _(message.value).defaults({
                    artist: '',
                    album: '',
                    title: '',
                    url: '',
                    length: 0,
                    artUrl: '',
                    trackId: '',
                });
            }
            port.get(this).postMessage(message);
        }

        /**
         * Get property from the injected script
         * @param {string} property - Property name. Should be different for different properties
         * @returns {Promise} Promise resolved with fetched value or rejected with timeout
         */
        getFromPage(property) {
            return new Promise((resolve, reject) => {
                const currentId = ids.get(this).get(property) || 0;
                ids.get(this).set(property, currentId + 1);
                const tid = setTimeout(() => {
                    window.removeEventListener('message', handleResponse);
                    reject(`Timeout: ${property}`);
                }, 2000);
                function handleResponse({data}) {
                    if (data.sender   !== 'wmc-page-getter'   ||
                        data.property !== property            ||
                        data.id       !== currentId           )
                    {
                        return;
                    }
                    clearTimeout(tid);
                    window.removeEventListener('message', handleResponse);
                    resolve(data.response);
                }
                window.addEventListener('message', handleResponse);
                window.postMessage({
                    sender: 'wmc-connector-getter',
                    property,
                    id: currentId,
                }, '*');
            });
        }

        /**
         * Send a command to injected script
         * @param {string} command - Command name
         * @param {object} argument - Optional argument
         */
        sendToPage(command, argument = null) {
            window.postMessage({
                sender: 'wmc-connector-command',
                command,
                argument,
            }, '*');
        }

        /**
         * Listen events from injected script and call `onStateChanged` when event fires.
         * Use `propertyNames` param in injected script for explicitly stating which props
         * have changed
         */
        listenPage() {
            this.onStateChanged();
            window.addEventListener('message', ({data}) => {
                if (data.sender !== 'wmc-page-notifier') return;

                this.onStateChanged(data.propertyNames);
            });
        }

        /**
         * Inject scripts from the specified URLs directly into page. Use it for getting info from
         * page objects or calling its' control methods
         * @param {string} urls - URLs of the script. Should be mentioned in web_accessible_resources manifest entry
         * @returns a Promise fullfilled when scripts is loaded. Use it for listening for page only when scripts are injected
         */
        injectScripts(...urls) {
            return new Promise((resolve) => {
                let injectedNumber = 0;
                for (let url of urls) {
                    const script = document.createElement('script');
                    script.src = chrome.extension.getURL(url);
                    script.addEventListener('load', () => {
                        ++injectedNumber;
                        if (injectedNumber === urls.length) {
                            resolve();
                        }
                    });
                    (document.head || document.documentElement).appendChild(script);
                }
            });
        }

        /**
         * A `document.querySelector` replacement with some batteries. Waits while there is at least one Node
         * which matches the selector and then resolves with this Node. Note that it uses MutationObserver on
         * the whole DOM, so making it wait long could be expensive
         * @param {string} selector - A valid CSS selector
         * @returns a Promise fullfilled with the first matching Node
         */
        query(selector) {
            if (selector == null) {
                return Promise.reject(new Error('selector is null'));
            }
            return new Promise((resolve) => {
                const elem = document.querySelector(selector);
                if (elem) {
                    resolve(elem);
                } else {
                    const waitObserver = new MutationObserver((mutations, observer) => {
                        const elem = document.querySelector(selector);
                        if (elem) {
                            observer.disconnect();
                            resolve(elem);
                        }
                    });
                    waitObserver.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        characterData: true,
                    });
                }
            });
        }

        /**
         * Calls `onStateChanged` when the `element` and/or its underlying subtree generates mutations.
         * Note that it's not suitable for watching events generated by those elements
         * @param {Node} element - The obseved element
         */
        observe(element) {
            const stateChangeObserver = new MutationObserver(() => {
                this.onStateChanged();
            });
            stateChangeObserver.observe(element, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
            });
        }

        singleWarn(message) {
            if (!displayedWarnings.get(this).has(message)) {
                displayedWarnings.get(this).add(message);
                console.warn(message);
            }
        }

        /**
         * Start media playback if not yet. It's intended to be overriden.
         */
        play() {
            if (this.pageActions.has('play')) {
                this.sendToPage('play');
            }
            Promise.resolve(this.playbackStatus).then(status => {
                if (status !== 'playing') {
                    this.playPause();
                }
            });
        }

        /**
         * Pause media playback if not yet. It's intended to be overriden.
         */
        pause() {
            if (this.pageActions.has('pause')) {
                this.sendToPage('pause');
            }
            Promise.resolve(this.playbackStatus).then(status => {
                if (status === 'playing') {
                    this.playPause();
                }
            });
        }

        /**
         * Toggle media playback. It's intended to be overriden.
         */
        playPause() {
            if (this.pageActions.has('playPause')) {
                this.sendToPage('playPause');
                return;
            }
            this.query(this.playButtonSelector)
                .then(btn => btn.click())
                .catch(() => {
                    Promise.resolve(this.playbackStatus)
                        .then((status) => {
                            if (status === 'playing') {
                                this.pause();
                            } else {
                                this.play();
                            }
                        });
                });
        }

        /**
         * Stop media playback. It's intended to be overriden.
         * When this method has no effect, `canStop` property should be false
         */
        stop() {
            if (this.pageActions.has('stop')) {
                this.sendToPage('stop');
                return;
            }
            this.query(this.stopButtonSelector)
                .then(btn => btn.click())
                .catch(() => this.singleWarn('Connector.stop not implemented'));
        }

        /**
         * Go to the previous track. It's intended to be overriden.
         * When this method has no effect, `canGoPrevious` property should be false
         */
        previous() {
            if (this.pageActions.has('previous')) {
                this.sendToPage('previous');
                return;
            }
            this.query(this.prevButtonSelector)
                .then(btn => btn.click())
                .catch(() => this.singleWarn('Connector.previous not implemented'));
        }

        /**
         * Go to the next track. It's intended to be overriden.
         * When this method has no effect, `canGoNext` property should be false
         */
        next() {
            if (this.pageActions.has('next')) {
                this.sendToPage('next');
                return;
            }
            this.query(this.nextButtonSelector)
                .then(btn => btn.click())
                .catch(() => this.singleWarn('Connector.next not implemented'));
        }


        /**
         * Seek for the given offset. Negative value means seek backwards.
         * @param {Number} offset - Offset in milliseconds
         */
        seek(offset) {
            if (this.pageActions.has('seek')) {
                this.sendToPage('seek', offset);
                return;
            }
            this.singleWarn('Connector.seek not implemented');
        }


        /**
         * Internal method for setting position. Doesn't perform anything if
         * given trackId does not match current one. If you want to override
         * this behaviour, you should return `null` from `get uniqueId()` instead
         * @param {string} trackId - ID of the track which was playing in the beginning of the action
         * @param {Number} position - Position in the song in milliseconds. Should be in [0; length]
         */
        set position({ trackId, position }) {
            Promise.resolve(this.trackId).then(curTrackId => {
                if (trackId !== curTrackId) return;
                this.currentTime = position;
            });
        }

        /**
         * Set position for the media playback. It's intended to be overriden
         * @param {Number} currentTime - Position in the song in milliseconds. Should be in [0; length]
         */
        set currentTime(currentTime) {
            if (this.pageSetters.has('currentTime')) {
                this.sendToPage('set currentTime', currentTime);
                return;
            }
            this.singleWarn('Connector.set currentTime not implemented');
        }


        /**
         * Set player volume. It's intended to be overriden
         * @param {Number} volume - New volume. Should be in [0; 1]
         */
        set volume(volume) {
            if (this.pageSetters.has('volume')) {
                this.sendToPage('set volume', volume);
                return;
            }
            this.singleWarn('Connector.set volume not implemented');
        }

        /**
         * Get current playback status. It *must* be overriden for proper work.
         * @returns {string} Playback status or Promise which fullfills with it.
         * Should be one of 'playing', 'paused' or 'stopped'
         */
        get playbackStatus() {
            if (this.pageGetters.has('playbackStatus')) {
                return this.getFromPage('playbackStatus');
            }
            this.singleWarn('Connector.get playbackStatus not implemented');
            return undefined;
        }


        /**
         * Get current position. It's intended to be overriden.
         * @returns {Number} Position or Promise which fullfills with it.
         * Should be in [0; length]
         */
        get currentTime() {
            if (this.pageGetters.has('currentTime')) {
                return this.getFromPage('currentTime');
            }
            return this.query(this.progressSelector)
                .then(node => {
                    let result = node.getAttribute('aria-valuenow');
                    result = parseFloat(result);
                    if (this.timeCoefficient != null) {
                        result *= this.timeCoefficient;
                    }
                    return result;
                })
                .catch(() => this.singleWarn('Connector.get currentTime not implemented'));
        }


        /**
         * Get current volume.
         * @returns {Number} Position or Promise which fullfills with it.
         * Should be in [0; 1]
         */
        get volume() {
            if (this.pageGetters.has('volume')) {
                return this.getFromPage('volume');
            }
            return this.query(this.volumeSelector)
                .then(node => {
                    let result = node.getAttribute('aria-valuenow');
                    result = parseFloat(result);
                    let max = node.getAttribute('aria-valuemax');
                    max = parseFloat(max);
                    return result / max;
                })
                .catch(() => this.singleWarn('Connector.get volume not implemented'));
        }

        /**
         * Get current control abilities. Their names are self-documented
         * @returns {object} the abilities or Promise whuch fullfills with it.
         */
        get properties() {
            return {
                canGoNext: true,
                canGoPrevious: true,
                canPlay: true,
                canPause: true,
                canSeek: true,
                canControl: true,
            };
        }

        /**
         * Get length of the current track. Should return null or undefined if
         * it does not make sense (e.g. stream). This method is intended to be overriden.
         * @returns {Number} length in milliseconds
         */
        get length() {
            if (this.pageGetters.has('length')) {
                return this.getFromPage('length');
            }
            return this.query(this.progressSelector)
                .then(node => {
                    let result = node.getAttribute('aria-valuemax');
                    result = parseFloat(result);
                    if (this.timeCoefficient != null) {
                        result *= this.timeCoefficient;
                    }
                    return result;
                })
                .catch(() => this.singleWarn('Connector.get length not implemented'));
        }

        /**
         * Get artist(s) of the current track. This method is intended to be overridden.
         * @returns {string|Array[string]} artist or artist list
         */
        get artist() {
            if (this.pageGetters.has('artist')) {
                return this.getFromPage('artist');
            }
            if (this.artistsSelector) {
                let artists = [];
                for (let node of document.querySelectorAll(this.artistsSelector)) {
                    artists.push(node.textContent);
                }
                return artists;
            }
            return this.query(this.artistSelector)
                .then(node => node.textContent)
                .catch(() => this.singleWarn('Connector.get artist not implemented'));
        }


        /**
         * Get album of the current track. This method is intended to be overriden.
         * @returns {string} album
         */
        get album() {
            if (this.pageGetters.has('album')) {
                return this.getFromPage('album');
            }
            return this.query(this.albumSelector)
                .then(node => node.textContent)
                .catch(() => this.singleWarn('Connector.get album not implemented'));
        }

        /**
         * Get title of the current track. This method is intended to be overriden.
         * @returns {string} title
         */
        get title() {
            if (this.pageGetters.has('title')) {
                return this.getFromPage('title');
            }
            return this.query(this.titleSelector)
                .then(node => node.textContent)
                .catch(() => this.singleWarn('Connector.get title not implemented'));
        }

        /**
         * Get URL of the album cover. This method is intended to be overriden.
         * @returns {string} URL of the album cover
         */
        get artUrl() {
            if (this.pageGetters.has('artUrl')) {
                return this.getFromPage('artUrl');
            }
            return this.query(this.artSelector)
                .then(node => node.src)
                .catch(() => this.singleWarn('Connector.get artUrl not implemented'));
        }

        /**
         * Get unique ID of the current track. Should be overridden if we can do that
         * and should be not overriden otherwise
         * @returns {string} ID
         */
        get uniqueId() {
            if (this.pageGetters.has('uniqueId')) {
                return this.getFromPage('uniqueId');
            }
            this.singleWarn('Connector.get uniqueId not implemented');
            return undefined;
        }

        /**
         * Append unique ID to the prefix or get to common ID for undefined
         * @returns {string} ID
         */
        get trackId() {
            return Promise.resolve(this.uniqueId).then(uniqueId => {
                if (!uniqueId) {
                    return '/me/f1u77y/web_media_controller/CurrentTrack';
                } else {
                    return `${prefix.get(this)}/${uniqueId}`;
                }
            });
        }

        /**
         * Get track info with other getters. May be overridden if you get info in other
         * way then with the field getters
         * @returns {object} Track Info
         */
        get trackInfo() {
            return Promise.all([
                this.length, this.artist, this.album, this.title, this.artUrl, this.trackId,
            ]).then(([length, artist, album, title, artUrl, trackId]) => {
                return { length, artist, album, title, artUrl, trackId };
            });
        }

        /**
         * Should be called when property `name` was changed for sending this event
         * to background. Should not be overridden and generally should be called only
         * internally
         * @param {function} getter - A getter function for the property
         * @param {string} name - The property name
         */
        onPropertyChanged(getter, name) {
            const throttle = throttleInterval[name];
            if (throttle != null) {
                const now = Date.now();
                if (now - lastCallTime.get(this).get(name) < throttle) return;
                lastCallTime.get(this).set(name, now);
            }

            Promise.resolve(getter).then(curValue => {
                if (!_.isEqual(curValue, lastValue.get(this).get(name))) {
                    lastValue.get(this).set(name, curValue);
                    this.sendProperty(name, curValue);
                }
            });
        }

        /**
         * Should be called when properties `propertyNames` were changed for sending
         * these events to background. Should not be overridden
         * @param {Array[string]} properties - The property names
         */
        onStateChanged(properties = propertyNames) {
            for (let name of properties) {
                this.onPropertyChanged(this[name], name);
            }
        }
    }

    return BaseConnector;
})();
