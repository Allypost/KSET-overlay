const jwt = require('jsonwebtoken');

const Message = require('./Message');
const Notification = require('./Notification');
const RateLimiter = require('./RateLimiter');
const Settings = require('./settings');

module.exports = class Socket {
    constructor(io = null) {
        this.messages = [ 'Pošaljite poruku!', 'KSET je lit', 'KOMP je najbolja sekcija' ].map((text) => new Message(text).inspect());
        this.rateLimiter = new RateLimiter(Settings.messagesIntervalLength, Settings.messagesPerInterval);
        this.events = {};

        if (io)
            this.init(io);

        this.on('settings change:messagesPerInterval', (messagesPerInterval) => {
            this.rateLimiter = this.rateLimiter.updatePerTimeframe(messagesPerInterval);
        });
    }

    static get maxMessagesLength() {
        return 10;
    }

    get settings() {
        return Settings;
    }

    get maxMessageLength() {
        return this.settings.maxMessageLength;
    }

    get secret() {
        return this.settings.secret;
    }

    init(io) {
        this.io = io;
        this.register();
    }

    on(event, fn = (() => 1)) {
        const eventList = this._eventList(event);

        this.events[ event ] = [ ...eventList, fn ];
    }

    _eventList(event) {
        const { [ event ]: eventList = [] } = this.events;

        return eventList;
    }

    _event(event, ...data) {
        this._eventList(event)
            .forEach((fn) => fn(...data));
    }

    getCookies(socket) {
        const cookieString = socket.handshake.headers.cookie || '';

        return (
            cookieString
                .split('; ')
                .map((cookie) => {
                    const [ key, ...value ] = cookie.split('=');

                    return [ key, value.join('=') ];
                })
                .reduce((acc, [ k, v ]) => Object.assign(acc, { [ k ]: v }), {})
        );
    }

    register() {
        const { io } = this;

        io.on('connection', (socket) => {
            const cookies = this.getCookies(socket);

            jwt.verify(cookies.auth, this.secret, (err, res) => {
                if (err)
                    return;

                socket.auth = res;
                this._registerAdmin(socket, cookies);
            });

            socket.join(cookies.id);

            const fn = (() => 0);

            socket.on('add message', (text, cb = fn) => {
                const { id } = cookies;

                const sent = this.sendMessage(id, text);
                const entry = this.rateLimiter.get(id).inspect();

                io.to(id).emit('meta', entry);

                cb(sent, entry);
            });

            socket.on('meta', (cb = fn) => {
                const { id } = cookies;
                const entry = this.rateLimiter.getOrCreate(id);

                cb(entry.inspect());
            });
        });
    }

    _registerAdmin(socket, cookies) {
        const fn = (() => 0);

        socket.join('admin');

        socket.use((socket, next) => {
            jwt.verify(cookies.auth, this.secret, (err, res) => {
                if (!err)
                    return next();

                socket.auth = null;

                next(new Error('Invalid auth token'));
            });
        });

        socket.on('get messages', (cb = fn) => {
            cb(this.getMessages());
        });

        socket.on('add message admin', (text, cb = fn) => {
            cb(this.sendMessage(null, text));
        });

        socket.on('edit message', (message, cb = fn) => {
            const success = this._editMessage(message);

            if (!success)
                return cb(success);

            this.send('edit message', message);
            cb(success);
        });

        socket.on('delete message', (id, cb = fn) => {
            this._deleteMessage(id);

            this.send('delete message', id);
            cb(id);
        });

        socket.on('get settings', (cb = fn) => {
            const settings = Object.assign({}, this.settings.inspect(), { secret: null });

            cb(settings);
        });

        socket.on('set settings', (newSettings, cb = fn) => {
            const types = this.settings.types;
            const allowedSettings = Object.keys(types);

            const settings =
                Object.entries(newSettings)
                      .filter(([ key ]) => allowedSettings.find((k) => k === key) !== undefined)
                      .map(([ k, v ]) => [ k, types[ k ](v) ])
                      .reduce((acc, [ k, v ]) => Object.assign(acc, { [ k ]: v }), {});

            function hasChanged(oldSettings, newSettings) {
                for (const [ k, v ] of Object.entries(newSettings))
                    if (oldSettings[ k ] !== v)
                        return true;

                return false;
            }

            if (!hasChanged(this.settings, settings))
                return cb(false);

            Object.assign(this.settings._args, settings);

            this._event('settings change', this.settings);
            Object.keys(settings)
                  .forEach((key) => this._event(`settings change:${key}`, settings[ key ]));

            const newSettingsObject = this.settings.inspect();

            this.send('settings change', newSettingsObject);

            cb(true);
        });

        socket.on('add notification', ({ title, text }, cb = fn) => {
            const notification = new Notification({ text, title }).inspect();

            this.send('add notification', notification);

            cb(notification);
        });
    }

    send(name, data = null) {
        const { io } = this;

        io.emit(name, data);
    }

    sendMessage(id = null, text = '') {
        text = text.trim();

        if (text.length < 2)
            return false;

        const message = this.addMessage(text);

        if (!id) {
            this.send('new message', message);
            return true;
        }

        const entry = this.rateLimiter.getOrCreate(id);

        if (!entry.can)
            return false;

        this.rateLimiter.update(entry);

        this.send('new message', message);
        return true;
    }

    addMessage(text) {
        const message =
            new Message(text)
                .withMaxLength(this.maxMessageLength)
                .inspect();

        this.messages.unshift(message);

        if (this.messages.length > Socket.maxMessagesLength)
            this.messages.pop();

        return message;
    }

    _editMessage(message) {
        const messageIndex = this.messages.findIndex(({ id }) => id === message.id);

        if (messageIndex < 0)
            return false;

        this.messages[ messageIndex ] = message;

        return true;
    }

    _deleteMessage(id) {
        const newMessages = this.messages.filter((message) => message.id !== id);

        this.messages = newMessages;

        return newMessages;
    }

    getMessages() {
        const messages = this.messages.slice();

        return messages.reverse();
    }
};
