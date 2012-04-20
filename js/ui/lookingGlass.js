// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Cogl = imports.gi.Cogl;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const St = imports.gi.St;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const Lang = imports.lang;
const Mainloop = imports.mainloop;

const History = imports.misc.history;
const ExtensionSystem = imports.ui.extensionSystem;
const ExtensionUtils = imports.misc.extensionUtils;
const Link = imports.ui.link;
const ShellEntry = imports.ui.shellEntry;
const Tweener = imports.ui.tweener;
const Main = imports.ui.main;
const JsParse = imports.misc.jsParse;

/* Imports...feel free to add here as needed */
var commandHeader = 'const Clutter = imports.gi.Clutter; ' +
                    'const GLib = imports.gi.GLib; ' +
                    'const Gtk = imports.gi.Gtk; ' +
                    'const Mainloop = imports.mainloop; ' +
                    'const Meta = imports.gi.Meta; ' +
                    'const Shell = imports.gi.Shell; ' +
                    'const Tp = imports.gi.TelepathyGLib; ' +
                    'const Main = imports.ui.main; ' +
                    'const Lang = imports.lang; ' +
                    'const Tweener = imports.ui.tweener; ' +
                    /* Utility functions...we should probably be able to use these
                     * in the shell core code too. */
                    'const stage = global.stage; ' +
                    'const color = function(pixel) { let c= new Clutter.Color(); c.from_pixel(pixel); return c; }; ' +
                    /* Special lookingGlass functions */
                       'const it = Main.lookingGlass.getIt(); ' +
                    'const r = Lang.bind(Main.lookingGlass, Main.lookingGlass.getResult); ';

const HISTORY_KEY = 'looking-glass-history';
// Time between tabs for them to count as a double-tab event
const AUTO_COMPLETE_DOUBLE_TAB_DELAY = 500;
const AUTO_COMPLETE_SHOW_COMPLETION_ANIMATION_DURATION = 0.2;
const AUTO_COMPLETE_GLOBAL_KEYWORDS = _getAutoCompleteGlobalKeywords();

function _getAutoCompleteGlobalKeywords() {
    const keywords = ['true', 'false', 'null', 'new'];
    // Don't add the private properties of window (i.e., ones starting with '_')
    const windowProperties = Object.getOwnPropertyNames(window).filter(function(a){ return a.charAt(0) != '_' });
    const headerProperties = JsParse.getDeclaredConstants(commandHeader);

    return keywords.concat(windowProperties).concat(headerProperties);
}

const AutoComplete = new Lang.Class({
    Name: 'AutoComplete',

    _init: function(entry) {
        this._entry = entry;
        this._entry.connect('key-press-event', Lang.bind(this, this._entryKeyPressEvent));
        this._lastTabTime = global.get_current_time();
    },

    _processCompletionRequest: function(event) {
        if (event.completions.length == 0) {
            return;
        }
        // Unique match = go ahead and complete; multiple matches + single tab = complete the common starting string;
        // multiple matches + double tab = emit a suggest event with all possible options
        if (event.completions.length == 1) {
            this.additionalCompletionText(event.completions[0], event.attrHead);
            this.emit('completion', { completion: event.completions[0], type: 'whole-word' });
        } else if (event.completions.length > 1 && event.tabType === 'single') {
            let commonPrefix = JsParse.getCommonPrefix(event.completions);

            if (commonPrefix.length > 0) {
                this.additionalCompletionText(commonPrefix, event.attrHead);
                this.emit('completion', { completion: commonPrefix, type: 'prefix' });
                this.emit('suggest', { completions: event.completions});
            }
        } else if (event.completions.length > 1 && event.tabType === 'double') {
            this.emit('suggest', { completions: event.completions});
        }
    },

    _entryKeyPressEvent: function(actor, event) {
        let cursorPos = this._entry.clutter_text.get_cursor_position();
        let text = this._entry.get_text();
        if (cursorPos != -1) {
            text = text.slice(0, cursorPos);
        }
        if (event.get_key_symbol() == Clutter.Tab) {
            let [completions, attrHead] = JsParse.getCompletions(text, commandHeader, AUTO_COMPLETE_GLOBAL_KEYWORDS);
            let currTime = global.get_current_time();
            if ((currTime - this._lastTabTime) < AUTO_COMPLETE_DOUBLE_TAB_DELAY) {
                this._processCompletionRequest({ tabType: 'double',
                                                 completions: completions,
                                                 attrHead: attrHead });
            } else {
                this._processCompletionRequest({ tabType: 'single',
                                                 completions: completions,
                                                 attrHead: attrHead });
            }
            this._lastTabTime = currTime;
        }
    },

    // Insert characters of text not already included in head at cursor position.  i.e., if text="abc" and head="a",
    // the string "bc" will be appended to this._entry
    additionalCompletionText: function(text, head) {
        let additionalCompletionText = text.slice(head.length);
        let cursorPos = this._entry.clutter_text.get_cursor_position();

        this._entry.clutter_text.insert_text(additionalCompletionText, cursorPos);
    }
});
Signals.addSignalMethods(AutoComplete.prototype);


const Notebook = new Lang.Class({
    Name: 'Notebook',

    _init: function() {
        this.actor = new St.BoxLayout({ vertical: true });

        this.tabControls = new St.BoxLayout({ style_class: 'labels' });

        this._selectedIndex = -1;
        this._tabs = [];
    },

    appendPage: function(name, child) {
        let labelBox = new St.BoxLayout({ style_class: 'notebook-tab',
                                          reactive: true,
                                          track_hover: true });
        let label = new St.Button({ label: name });
        label.connect('clicked', Lang.bind(this, function () {
            this.selectChild(child);
            return true;
        }));
        labelBox.add(label, { expand: true });
        this.tabControls.add(labelBox);

        let scrollview = new St.ScrollView({ x_fill: true, y_fill: true });
        scrollview.get_hscroll_bar().hide();
        scrollview.add_actor(child);

        let tabData = { child: child,
                        labelBox: labelBox,
                        label: label,
                        scrollView: scrollview,
                        _scrollToBottom: false };
        this._tabs.push(tabData);
        scrollview.hide();
        this.actor.add(scrollview, { expand: true });

        let vAdjust = scrollview.vscroll.adjustment;
        vAdjust.connect('changed', Lang.bind(this, function () { this._onAdjustScopeChanged(tabData); }));
        vAdjust.connect('notify::value', Lang.bind(this, function() { this._onAdjustValueChanged(tabData); }));

        if (this._selectedIndex == -1)
            this.selectIndex(0);
    },

    _unselect: function() {
        if (this._selectedIndex < 0)
            return;
        let tabData = this._tabs[this._selectedIndex];
        tabData.labelBox.remove_style_pseudo_class('selected');
        tabData.scrollView.hide();
        this._selectedIndex = -1;
    },

    selectIndex: function(index) {
        if (index == this._selectedIndex)
            return;
        if (index < 0) {
            this._unselect();
            this.emit('selection', null);
            return;
        }

        // Focus the new tab before unmapping the old one
        let tabData = this._tabs[index];
        if (!tabData.scrollView.navigate_focus(null, Gtk.DirectionType.TAB_FORWARD, false))
            this.actor.grab_key_focus();

        this._unselect();

        tabData.labelBox.add_style_pseudo_class('selected');
        tabData.scrollView.show();
        this._selectedIndex = index;
        this.emit('selection', tabData.child);
    },

    selectChild: function(child) {
        if (child == null)
            this.selectIndex(-1);
        else {
            for (let i = 0; i < this._tabs.length; i++) {
                let tabData = this._tabs[i];
                if (tabData.child == child) {
                    this.selectIndex(i);
                    return;
                }
            }
        }
    },

    scrollToBottom: function(index) {
        let tabData = this._tabs[index];
        tabData._scrollToBottom = true;

    },

    _onAdjustValueChanged: function (tabData) {
        let vAdjust = tabData.scrollView.vscroll.adjustment;
        if (vAdjust.value < (vAdjust.upper - vAdjust.lower - 0.5))
            tabData._scrolltoBottom = false;
    },

    _onAdjustScopeChanged: function (tabData) {
        if (!tabData._scrollToBottom)
            return;
        let vAdjust = tabData.scrollView.vscroll.adjustment;
        vAdjust.value = vAdjust.upper - vAdjust.page_size;
    },

    nextTab: function() {
        let nextIndex = this._selectedIndex;
        if (nextIndex < this._tabs.length - 1) {
            ++nextIndex;
        }

        this.selectIndex(nextIndex);
    },

    prevTab: function() {
        let prevIndex = this._selectedIndex;
        if (prevIndex > 0) {
            --prevIndex;
        }

        this.selectIndex(prevIndex);
    }
});
Signals.addSignalMethods(Notebook.prototype);

function objectToString(o) {
    if (typeof(o) == typeof(objectToString)) {
        // special case this since the default is way, way too verbose
        return '<js function>';
    } else {
        return '' + o;
    }
}

const ObjLink = new Lang.Class({
    Name: 'ObjLink',
    Extends: Link.Link,

    _init: function(o, title) {
        let text;
        if (title)
            text = title;
        else
            text = objectToString(o);
        text = GLib.markup_escape_text(text, -1);
        this._obj = o;

        this.parent({ label: text });
        this.actor.get_child().single_line_mode = true;
        this.actor.connect('clicked', Lang.bind(this, this._onClicked));
    },

    _onClicked: function (link) {
        Main.lookingGlass.inspectObject(this._obj, this.actor);
    }
});

const Result = new Lang.Class({
    Name: 'Result',

    _init : function(command, o, index) {
        this.index = index;
        this.o = o;

        this.actor = new St.BoxLayout({ vertical: true });

        let cmdTxt = new St.Label({ text: command });
        cmdTxt.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.actor.add(cmdTxt);
        let box = new St.BoxLayout({});
        this.actor.add(box);
        let resultTxt = new St.Label({ text: 'r(' + index + ') = ' });
        resultTxt.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add(resultTxt);
        let objLink = new ObjLink(o);
        box.add(objLink.actor);
        let line = new Clutter.Rectangle({ name: 'Separator' });
        let padBin = new St.Bin({ name: 'Separator', x_fill: true, y_fill: true });
        padBin.add_actor(line);
        this.actor.add(padBin);
    }
});

const WindowList = new Lang.Class({
    Name: 'WindowList',

    _init : function () {
        this.actor = new St.BoxLayout({ name: 'Windows', vertical: true, style: 'spacing: 8px' });
        let tracker = Shell.WindowTracker.get_default();
        this._updateId = Main.initializeDeferredWork(this.actor, Lang.bind(this, this._updateWindowList));
        global.display.connect('window-created', Lang.bind(this, this._updateWindowList));
        tracker.connect('tracked-windows-changed', Lang.bind(this, this._updateWindowList));
    },

    _updateWindowList: function() {
        this.actor.get_children().forEach(function (actor) { actor.destroy(); });
        let windows = global.get_window_actors();
        let tracker = Shell.WindowTracker.get_default();
        for (let i = 0; i < windows.length; i++) {
            let metaWindow = windows[i].metaWindow;
            // Avoid multiple connections
            if (!metaWindow._lookingGlassManaged) {
                metaWindow.connect('unmanaged', Lang.bind(this, this._updateWindowList));
                metaWindow._lookingGlassManaged = true;
            }
            let box = new St.BoxLayout({ vertical: true });
            this.actor.add(box);
            let windowLink = new ObjLink(metaWindow, metaWindow.title);
            box.add(windowLink.actor, { x_align: St.Align.START, x_fill: false });
            let propsBox = new St.BoxLayout({ vertical: true, style: 'padding-left: 6px;' });
            box.add(propsBox);
            propsBox.add(new St.Label({ text: 'wmclass: ' + metaWindow.get_wm_class() }));
            let app = tracker.get_window_app(metaWindow);
            if (app != null && !app.is_window_backed()) {
                let icon = app.create_icon_texture(22);
                let propBox = new St.BoxLayout({ style: 'spacing: 6px; ' });
                propsBox.add(propBox);
                propBox.add(new St.Label({ text: 'app: ' }), { y_fill: false });
                let appLink = new ObjLink(app, app.get_id());
                propBox.add(appLink.actor, { y_fill: false });
                propBox.add(icon, { y_fill: false });
            } else {
                propsBox.add(new St.Label({ text: '<untracked>' }));
            }
        }
    }
});
Signals.addSignalMethods(WindowList.prototype);

const ObjInspector = new Lang.Class({
    Name: 'ObjInspector',

    _init : function () {
        this._obj = null;
        this._previousObj = null;

        this._parentList = [];

        this.actor = new St.ScrollView({ x_fill: true, y_fill: true });
        this.actor.get_hscroll_bar().hide();
        this._container = new St.BoxLayout({ name: 'LookingGlassPropertyInspector',
                                             style_class: 'lg-dialog',
                                             vertical: true });
        this.actor.add_actor(this._container);
    },

    selectObject: function(obj, skipPrevious) {
        if (!skipPrevious)
            this._previousObj = this._obj;
        else
            this._previousObj = null;
        this._obj = obj;

        this._container.get_children().forEach(function (child) { child.destroy(); });

        let hbox = new St.BoxLayout({ style_class: 'lg-obj-inspector-title' });
        this._container.add_actor(hbox);
        let label = new St.Label({ text: 'Inspecting: %s: %s'.format(typeof(obj),
                                                                     objectToString(obj)) });
        label.single_line_mode = true;
        hbox.add(label, { expand: true, y_fill: false });
        let button = new St.Button({ label: 'Insert', style_class: 'lg-obj-inspector-button' });
        button.connect('clicked', Lang.bind(this, this._onInsert));
        hbox.add(button);

        if (this._previousObj != null) {
            button = new St.Button({ label: 'Back', style_class: 'lg-obj-inspector-button' });
            button.connect('clicked', Lang.bind(this, this._onBack));
            hbox.add(button);
        }

        button = new St.Button({ style_class: 'window-close' });
        button.connect('clicked', Lang.bind(this, this.close));
        hbox.add(button);
        if (typeof(obj) == typeof({})) {
            let properties = [];
            for (let propName in obj) {
                properties.push(propName);
            }
            properties.sort();

            for (let i = 0; i < properties.length; i++) {
                let propName = properties[i];
                let valueStr;
                let link;
                try {
                    let prop = obj[propName];
                    link = new ObjLink(prop).actor;
                } catch (e) {
                    link = new St.Label({ text: '<error>' });
                }
                let hbox = new St.BoxLayout();
                let propText = propName + ': ' + valueStr;
                hbox.add(new St.Label({ text: propName + ': ' }));
                hbox.add(link);
                this._container.add_actor(hbox);
            }
        }
    },

    open: function(sourceActor) {
        if (this._open)
            return;
        this._previousObj = null;
        this._open = true;
        this.actor.show();
        if (sourceActor) {
            this.actor.set_scale(0, 0);
            let [sourceX, sourceY] = sourceActor.get_transformed_position();
            let [sourceWidth, sourceHeight] = sourceActor.get_transformed_size();
            this.actor.move_anchor_point(Math.floor(sourceX + sourceWidth / 2),
                                         Math.floor(sourceY + sourceHeight / 2));
            Tweener.addTween(this.actor, { scale_x: 1, scale_y: 1,
                                           transition: 'easeOutQuad',
                                           time: 0.2 });
        } else {
            this.actor.set_scale(1, 1);
        }
    },

    close: function() {
        if (!this._open)
            return;
        this._open = false;
        this.actor.hide();
        this._previousObj = null;
        this._obj = null;
    },

    _onInsert: function() {
        let obj = this._obj;
        this.close();
        Main.lookingGlass.insertObject(obj);
    },

    _onBack: function() {
        this.selectObject(this._previousObj, true);
    }
});

function addBorderPaintHook(actor) {
    let signalId = actor.connect_after('paint',
        function () {
            let color = new Cogl.Color();
            color.init_from_4ub(0xff, 0, 0, 0xc4);
            Cogl.set_source_color(color);

            let geom = actor.get_allocation_geometry();
            let width = 2;

            // clockwise order
            Cogl.rectangle(0, 0, geom.width, width);
            Cogl.rectangle(geom.width - width, width,
                           geom.width, geom.height);
            Cogl.rectangle(0, geom.height,
                           geom.width - width, geom.height - width);
            Cogl.rectangle(0, geom.height - width,
                           width, width);
        });

    actor.queue_redraw();
    return signalId;
}

const Inspector = new Lang.Class({
    Name: 'Inspector',

    _init: function() {
        let container = new Shell.GenericContainer({ width: 0,
                                                     height: 0 });
        container.connect('allocate', Lang.bind(this, this._allocate));
        Main.uiGroup.add_actor(container);

        let eventHandler = new St.BoxLayout({ name: 'LookingGlassDialog',
                                              vertical: false,
                                              reactive: true });
        this._eventHandler = eventHandler;
        container.add_actor(eventHandler);
        this._displayText = new St.Label();
        eventHandler.add(this._displayText, { expand: true });

        this._borderPaintTarget = null;
        this._borderPaintId = null;
        eventHandler.connect('destroy', Lang.bind(this, this._onDestroy));
        eventHandler.connect('key-press-event', Lang.bind(this, this._onKeyPressEvent));
        eventHandler.connect('button-press-event', Lang.bind(this, this._onButtonPressEvent));
        eventHandler.connect('scroll-event', Lang.bind(this, this._onScrollEvent));
        eventHandler.connect('motion-event', Lang.bind(this, this._onMotionEvent));
        Clutter.grab_pointer(eventHandler);
        Clutter.grab_keyboard(eventHandler);

        // this._target is the actor currently shown by the inspector.
        // this._pointerTarget is the actor directly under the pointer.
        // Normally these are the same, but if you use the scroll wheel
        // to drill down, they'll diverge until you either scroll back
        // out, or move the pointer outside of _pointerTarget.
        this._target = null;
        this._pointerTarget = null;
    },

    _allocate: function(actor, box, flags) {
        if (!this._eventHandler)
            return;

        let primary = Main.layoutManager.primaryMonitor;

        let [minWidth, minHeight, natWidth, natHeight] =
            this._eventHandler.get_preferred_size();

        let childBox = new Clutter.ActorBox();
        childBox.x1 = primary.x + Math.floor((primary.width - natWidth) / 2);
        childBox.x2 = childBox.x1 + natWidth;
        childBox.y1 = primary.y + Math.floor((primary.height - natHeight) / 2);
        childBox.y2 = childBox.y1 + natHeight;
        this._eventHandler.allocate(childBox, flags);
    },

    _close: function() {
        Clutter.ungrab_pointer(this._eventHandler);
        Clutter.ungrab_keyboard(this._eventHandler);
        this._eventHandler.destroy();
        this._eventHandler = null;
        this.emit('closed');
    },

    _onDestroy: function() {
        if (this._borderPaintTarget != null)
            this._borderPaintTarget.disconnect(this._borderPaintId);
    },

    _onKeyPressEvent: function (actor, event) {
        if (event.get_key_symbol() == Clutter.Escape)
            this._close();
        return true;
    },

    _onButtonPressEvent: function (actor, event) {
        if (this._target) {
            let [stageX, stageY] = event.get_coords();
            this.emit('target', this._target, stageX, stageY);
        }
        this._close();
        return true;
    },

    _onScrollEvent: function (actor, event) {
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            // select parent
            let parent = this._target.get_parent();
            if (parent != null) {
                this._target = parent;
                this._update(event);
            }
            break;

        case Clutter.ScrollDirection.DOWN:
            // select child
            if (this._target != this._pointerTarget) {
                let child = this._pointerTarget;
                while (child) {
                    let parent = child.get_parent();
                    if (parent == this._target)
                        break;
                    child = parent;
                }
                if (child) {
                    this._target = child;
                    this._update(event);
                }
            }
            break;

        default:
            break;
        }
        return true;
    },

    _onMotionEvent: function (actor, event) {
        this._update(event);
        return true;
    },

    _update: function(event) {
        let [stageX, stageY] = event.get_coords();
        let target = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
                                                   stageX,
                                                   stageY);

        if (target != this._pointerTarget)
            this._target = target;
        this._pointerTarget = target;

        let position = '[inspect x: ' + stageX + ' y: ' + stageY + ']';
        this._displayText.text = '';
        this._displayText.text = position + ' ' + this._target;

        if (this._borderPaintTarget != this._target) {
            if (this._borderPaintTarget != null)
                this._borderPaintTarget.disconnect(this._borderPaintId);
            this._borderPaintTarget = this._target;
            this._borderPaintId = addBorderPaintHook(this._target);
        }
    }
});

Signals.addSignalMethods(Inspector.prototype);

const ErrorLog = new Lang.Class({
    Name: 'ErrorLog',

    _init: function() {
        this.actor = new St.BoxLayout();
        this.text = new St.Label();
        this.actor.add(this.text);
        // We need to override StLabel's default ellipsization when
        // using line_wrap; otherwise ClutterText's layout is going
        // to constrain both the width and height, which prevents
        // scrolling.
        this.text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this.text.clutter_text.line_wrap = true;
        this.actor.connect('notify::mapped', Lang.bind(this, this._renderText));
    },

    _formatTime: function(d){
        function pad(n) { return n < 10 ? '0' + n : n; }
        return d.getUTCFullYear()+'-'
            + pad(d.getUTCMonth()+1)+'-'
            + pad(d.getUTCDate())+'T'
            + pad(d.getUTCHours())+':'
            + pad(d.getUTCMinutes())+':'
            + pad(d.getUTCSeconds())+'Z';
    },

    _renderText: function() {
        if (!this.actor.mapped)
            return;
        let text = this.text.text;
        let stack = Main._getAndClearErrorStack();
        for (let i = 0; i < stack.length; i++) {
            let logItem = stack[i];
            text += logItem.category + ' t=' + this._formatTime(new Date(logItem.timestamp)) + ' ' + logItem.message + '\n';
        }
        this.text.text = text;
    }
});

const Memory = new Lang.Class({
    Name: 'Memory',

    _init: function() {
        this.actor = new St.BoxLayout({ vertical: true });
        this._glibc_uordblks = new St.Label();
        this.actor.add(this._glibc_uordblks);

        this._js_bytes = new St.Label();
        this.actor.add(this._js_bytes);

        this._gjs_boxed = new St.Label();
        this.actor.add(this._gjs_boxed);

        this._gjs_gobject = new St.Label();
        this.actor.add(this._gjs_gobject);

        this._gjs_function = new St.Label();
        this.actor.add(this._gjs_function);

        this._gjs_closure = new St.Label();
        this.actor.add(this._gjs_closure);

        this._last_gc_seconds_ago = new St.Label();
        this.actor.add(this._last_gc_seconds_ago);

        this._gcbutton = new St.Button({ label: 'Full GC',
                                         style_class: 'lg-obj-inspector-button' });
        this._gcbutton.connect('clicked', Lang.bind(this, function () { global.gc(); this._renderText(); }));
        this.actor.add(this._gcbutton, { x_align: St.Align.START,
                                         x_fill: false });

        this.actor.connect('notify::mapped', Lang.bind(this, this._renderText));
    },

    _renderText: function() {
        if (!this.actor.mapped)
            return;
        let memInfo = global.get_memory_info();
        this._glibc_uordblks.text = 'glibc_uordblks: ' + memInfo.glibc_uordblks;
        this._js_bytes.text = 'js bytes: ' + memInfo.js_bytes;
        this._gjs_boxed.text = 'gjs_boxed: ' + memInfo.gjs_boxed;
        this._gjs_gobject.text = 'gjs_gobject: ' + memInfo.gjs_gobject;
        this._gjs_function.text = 'gjs_function: ' + memInfo.gjs_function;
        this._gjs_closure.text = 'gjs_closure: ' + memInfo.gjs_closure;
        this._last_gc_seconds_ago.text = 'last_gc_seconds_ago: ' + memInfo.last_gc_seconds_ago;
    }
});

const Extensions = new Lang.Class({
    Name: 'Extensions',

    _init: function() {
        this.actor = new St.BoxLayout({ vertical: true,
                                        name: 'lookingGlassExtensions' });
        this._noExtensions = new St.Label({ style_class: 'lg-extensions-none',
                                             text: _("No extensions installed") });
        this._numExtensions = 0;
        this._extensionsList = new St.BoxLayout({ vertical: true,
                                                  style_class: 'lg-extensions-list' });
        this._extensionsList.add(this._noExtensions);
        this.actor.add(this._extensionsList);

        for (let uuid in ExtensionUtils.extensions)
            this._loadExtension(null, uuid);

        ExtensionSystem.connect('extension-loaded',
                                Lang.bind(this, this._loadExtension));
    },

    _loadExtension: function(o, uuid) {
        let extension = ExtensionUtils.extensions[uuid];
        // There can be cases where we create dummy extension metadata
        // that's not really a proper extension. Don't bother with these.
        if (!extension.metadata.name)
            return;

        let extensionDisplay = this._createExtensionDisplay(extension);
        if (this._numExtensions == 0)
            this._extensionsList.remove_actor(this._noExtensions);

        this._numExtensions ++;
        this._extensionsList.add(extensionDisplay);
    },

    _onViewSource: function (actor) {
        let extension = actor._extension;
        let uri = extension.dir.get_uri();
        Gio.app_info_launch_default_for_uri(uri, global.create_app_launch_context());
        Main.lookingGlass.close();
    },

    _onWebPage: function (actor) {
        let extension = actor._extension;
        Gio.app_info_launch_default_for_uri(extension.metadata.url, global.create_app_launch_context());
        Main.lookingGlass.close();
    },

    _onViewErrors: function (actor) {
        let extension = actor._extension;
        let shouldShow = !actor._isShowing;

        if (shouldShow) {
            let errors = extension.errors;
            let errorDisplay = new St.BoxLayout({ vertical: true });
            if (errors && errors.length) {
                for (let i = 0; i < errors.length; i ++)
                    errorDisplay.add(new St.Label({ text: errors[i] }));
            } else {
                /* Translators: argument is an extension UUID. */
                let message = _("%s has not emitted any errors.").format(extension.uuid);
                errorDisplay.add(new St.Label({ text: message }));
            }

            actor._errorDisplay = errorDisplay;
            actor._parentBox.add(errorDisplay);
            actor.label = _("Hide Errors");
        } else {
            actor._errorDisplay.destroy();
            actor._errorDisplay = null;
            actor.label = _("Show Errors");
        }

        actor._isShowing = shouldShow;
    },

    _stateToString: function(extensionState) {
        switch (extensionState) {
            case ExtensionSystem.ExtensionState.ENABLED:
                return _("Enabled");
            case ExtensionSystem.ExtensionState.DISABLED:
            case ExtensionSystem.ExtensionState.INITIALIZED:
                return _("Disabled");
            case ExtensionSystem.ExtensionState.ERROR:
                return _("Error");
            case ExtensionSystem.ExtensionState.OUT_OF_DATE:
                return _("Out of date");
            case ExtensionSystem.ExtensionState.DOWNLOADING:
                return _("Downloading");
        }
        return 'Unknown'; // Not translated, shouldn't appear
    },

    _createExtensionDisplay: function(extension) {
        let box = new St.BoxLayout({ style_class: 'lg-extension', vertical: true });
        let name = new St.Label({ style_class: 'lg-extension-name',
                                   text: extension.metadata.name });
        box.add(name, { expand: true });
        let description = new St.Label({ style_class: 'lg-extension-description',
                                         text: extension.metadata.description || 'No description' });
        box.add(description, { expand: true });

        let metaBox = new St.BoxLayout({ style_class: 'lg-extension-meta' });
        box.add(metaBox);
        let stateString = this._stateToString(extension.state);
        let state = new St.Label({ style_class: 'lg-extension-state',
                                   text: this._stateToString(extension.state) });
        metaBox.add(state);

        let viewsource = new Link.Link({ label: _("View Source") });
        viewsource.actor._extension = extension;
        viewsource.actor.connect('clicked', Lang.bind(this, this._onViewSource));
        metaBox.add(viewsource.actor);

        if (extension.metadata.url) {
            let webpage = new Link.Link({ label: _("Web Page") });
            webpage.actor._extension = extension;
            webpage.actor.connect('clicked', Lang.bind(this, this._onWebPage));
            metaBox.add(webpage.actor);
        }

        let viewerrors = new Link.Link({ label: _("Show Errors") });
        viewerrors.actor._extension = extension;
        viewerrors.actor._parentBox = box;
        viewerrors.actor._isShowing = false;
        viewerrors.actor.connect('clicked', Lang.bind(this, this._onViewErrors));
        metaBox.add(viewerrors.actor);

        return box;
    }
});

const LookingGlass = new Lang.Class({
    Name: 'LookingGlass',

    _init : function() {
        this._borderPaintTarget = null;
        this._borderPaintId = 0;
        this._borderDestroyId = 0;

        this._open = false;

        this._offset = 0;
        this._results = [];

        // Sort of magic, but...eh.
        this._maxItems = 150;

        this.actor = new St.BoxLayout({ name: 'LookingGlassDialog',
                                        style_class: 'lg-dialog',
                                        vertical: true,
                                        visible: false,
                                        reactive: true });
        this.actor.connect('key-press-event', Lang.bind(this, this._globalKeyPressEvent));

        this._interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        this._interfaceSettings.connect('changed::monospace-font-name',
                                        Lang.bind(this, this._updateFont));
        this._updateFont();

        // We want it to appear to slide out from underneath the panel
        Main.layoutManager.panelBox.add_actor(this.actor);
        this.actor.lower_bottom();
        Main.layoutManager.panelBox.connect('allocation-changed',
                                            Lang.bind(this, this._queueResize));
        Main.layoutManager.keyboardBox.connect('allocation-changed',
                                               Lang.bind(this, this._queueResize));

        this._objInspector = new ObjInspector();
        Main.uiGroup.add_actor(this._objInspector.actor);
        this._objInspector.actor.hide();

        let toolbar = new St.BoxLayout({ name: 'Toolbar' });
        this.actor.add_actor(toolbar);
        let inspectIcon = new St.Icon({ icon_name: 'gtk-color-picker',
                                        icon_type: St.IconType.FULLCOLOR,
                                        icon_size: 24 });
        toolbar.add_actor(inspectIcon);
        inspectIcon.reactive = true;
        inspectIcon.connect('button-press-event', Lang.bind(this, function () {
            let inspector = new Inspector();
            inspector.connect('target', Lang.bind(this, function(i, target, stageX, stageY) {
                this._pushResult('<inspect x:' + stageX + ' y:' + stageY + '>',
                                 target);
            }));
            inspector.connect('closed', Lang.bind(this, function() {
                this.actor.show();
                global.stage.set_key_focus(this._entry);
            }));
            this.actor.hide();
            return true;
        }));

        let notebook = new Notebook();
        this._notebook = notebook;
        this.actor.add(notebook.actor, { expand: true });

        let emptyBox = new St.Bin();
        toolbar.add(emptyBox, { expand: true });
        toolbar.add_actor(notebook.tabControls);

        this._evalBox = new St.BoxLayout({ name: 'EvalBox', vertical: true });
        notebook.appendPage('Evaluator', this._evalBox);

        this._resultsArea = new St.BoxLayout({ name: 'ResultsArea', vertical: true });
        this._evalBox.add(this._resultsArea, { expand: true });

        this._entryArea = new St.BoxLayout({ name: 'EntryArea' });
        this._evalBox.add_actor(this._entryArea);

        let label = new St.Label({ text: 'js>>> ' });
        this._entryArea.add(label);

        this._entry = new St.Entry({ can_focus: true });
        ShellEntry.addContextMenu(this._entry);
        this._entryArea.add(this._entry, { expand: true });

        this._windowList = new WindowList();
        this._windowList.connect('selected', Lang.bind(this, function(list, window) {
            notebook.selectIndex(0);
            this._pushResult('<window selection>', window);
        }));
        notebook.appendPage('Windows', this._windowList.actor);

        this._errorLog = new ErrorLog();
        notebook.appendPage('Errors', this._errorLog.actor);

        this._memory = new Memory();
        notebook.appendPage('Memory', this._memory.actor);

        this._extensions = new Extensions();
        notebook.appendPage('Extensions', this._extensions.actor);

        this._entry.clutter_text.connect('activate', Lang.bind(this, function (o, e) {
            // Hide any completions we are currently showing
            this._hideCompletions();

            let text = o.get_text();
            // Ensure we don't get newlines in the command; the history file is
            // newline-separated.
            text.replace('\n', ' ');
            // Strip leading and trailing whitespace
            text = text.replace(/^\s+/g, '').replace(/\s+$/g, '');
            if (text == '')
                return true;
            this._evaluate(text);
            return true;
        }));

        this._history = new History.HistoryManager({ gsettingsKey: HISTORY_KEY, 
                                                     entry: this._entry.clutter_text });

        this._autoComplete = new AutoComplete(this._entry);
        this._autoComplete.connect('suggest', Lang.bind(this, function(a,e) {
            this._showCompletions(e.completions);
        }));
        // If a completion is completed unambiguously, the currently-displayed completion
        // suggestions become irrelevant.
        this._autoComplete.connect('completion', Lang.bind(this, function(a,e) {
            if (e.type == 'whole-word')
                this._hideCompletions();
        }));

        this._resize();
    },

    _updateFont: function() {
        let fontName = this._interfaceSettings.get_string('monospace-font-name');
        // This is mishandled by the scanner - should by Pango.FontDescription_from_string(fontName);
        // https://bugzilla.gnome.org/show_bug.cgi?id=595889
        let fontDesc = Pango.font_description_from_string(fontName);
        // We ignore everything but size and style; you'd be crazy to set your system-wide
        // monospace font to be bold/oblique/etc. Could easily be added here.
        this.actor.style =
            'font-size: ' + fontDesc.get_size() / 1024. + (fontDesc.get_size_is_absolute() ? 'px' : 'pt') + ';'
            + 'font-family: "' + fontDesc.get_family() + '";';
    },

    _pushResult: function(command, obj) {
        let index = this._results.length + this._offset;
        let result = new Result('>>> ' + command, obj, index);
        this._results.push(result);
        this._resultsArea.add(result.actor);
        if (this._borderPaintTarget != null) {
            this._borderPaintTarget.disconnect(this._borderPaintId);
            this._borderPaintTarget = null;
        }
        if (obj instanceof Clutter.Actor) {
            this._borderPaintTarget = obj;
            this._borderPaintId = addBorderPaintHook(obj);
            this._borderDestroyId = obj.connect('destroy', Lang.bind(this, function () {
                this._borderDestroyId = 0;
                this._borderPaintTarget = null;
            }));
        }
        let children = this._resultsArea.get_children();
        if (children.length > this._maxItems) {
            this._results.shift();
            children[0].destroy();
            this._offset++;
        }
        this._it = obj;

        // Scroll to bottom
        this._notebook.scrollToBottom(0);
    },

    _showCompletions: function(completions) {
        if (!this._completionActor) {
            let actor = new St.BoxLayout({ vertical: true });

            this._completionText = new St.Label({ name: 'LookingGlassAutoCompletionText', style_class: 'lg-completions-text' });
            this._completionText.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._completionText.clutter_text.line_wrap = true;
            actor.add(this._completionText);

            let line = new Clutter.Rectangle();
            let padBin = new St.Bin({ x_fill: true, y_fill: true });
            padBin.add_actor(line);
            actor.add(padBin);

            this._completionActor = actor;
            this._evalBox.insert_child_below(this._completionActor, this._entryArea);
        }

        this._completionText.set_text(completions.join(', '));

        // Setting the height to -1 allows us to get its actual preferred height rather than
        // whatever was last given in set_height by Tweener.
        this._completionActor.set_height(-1);
        let [minHeight, naturalHeight] = this._completionText.get_preferred_height(this._resultsArea.get_width());

        // Don't reanimate if we are already visible
        if (this._completionActor.visible) {
            this._completionActor.height = naturalHeight;
        } else {
            this._completionActor.show();
            Tweener.removeTweens(this._completionActor);
            Tweener.addTween(this._completionActor, { time: AUTO_COMPLETE_SHOW_COMPLETION_ANIMATION_DURATION / St.get_slow_down_factor(),
                                                      transition: 'easeOutQuad',
                                                      height: naturalHeight,
                                                      opacity: 255
                                                    });
        }
    },

    _hideCompletions: function() {
        if (this._completionActor) {
            Tweener.removeTweens(this._completionActor);
            Tweener.addTween(this._completionActor, { time: AUTO_COMPLETE_SHOW_COMPLETION_ANIMATION_DURATION / St.get_slow_down_factor(),
                                                      transition: 'easeOutQuad',
                                                      height: 0,
                                                      opacity: 0,
                                                      onComplete: Lang.bind(this, function () {
                                                          this._completionActor.hide();
                                                      })
                                                    });
        }
    },

    _evaluate : function(command) {
        this._history.addItem(command);

        let fullCmd = commandHeader + command;

        let resultObj;
        try {
            resultObj = eval(fullCmd);
        } catch (e) {
            resultObj = '<exception ' + e + '>';
        }

        this._pushResult(command, resultObj);
        this._entry.text = '';
    },

    getIt: function () {
        return this._it;
    },

    getResult: function(idx) {
        return this._results[idx - this._offset].o;
    },

    toggle: function() {
        if (this._open)
            this.close();
        else
            this.open();
    },

    _queueResize: function() {
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW,
                       Lang.bind(this, function () { this._resize(); }));
    },

    _resize: function() {
        let primary = Main.layoutManager.primaryMonitor;
        let myWidth = primary.width * 0.7;
        let availableHeight = primary.height - Main.layoutManager.keyboardBox.height;
        let myHeight = Math.min(primary.height * 0.7, availableHeight * 0.9);
        this.actor.x = (primary.width - myWidth) / 2;
        this._hiddenY = this.actor.get_parent().height - myHeight - 4; // -4 to hide the top corners
        this._targetY = this._hiddenY + myHeight;
        this.actor.y = this._hiddenY;
        this.actor.width = myWidth;
        this.actor.height = myHeight;
        this._objInspector.actor.set_size(Math.floor(myWidth * 0.8), Math.floor(myHeight * 0.8));
        this._objInspector.actor.set_position(this.actor.x + Math.floor(myWidth * 0.1),
                                              this._targetY + Math.floor(myHeight * 0.1));
    },

    insertObject: function(obj) {
        this._pushResult('<insert>', obj);
    },

    inspectObject: function(obj, sourceActor) {
        this._objInspector.open(sourceActor);
        this._objInspector.selectObject(obj);
    },

    // Handle key events which are relevant for all tabs of the LookingGlass
    _globalKeyPressEvent : function(actor, event) {
        let symbol = event.get_key_symbol();
        let modifierState = event.get_state();
        if (symbol == Clutter.Escape) {
            if (this._objInspector.actor.visible) {
                this._objInspector.close();
            } else {
                this.close();
            }
            return true;
        }
        // Ctrl+PgUp and Ctrl+PgDown switches tabs in the notebook view
        if (modifierState & Clutter.ModifierType.CONTROL_MASK) {
            if (symbol == Clutter.KEY_Page_Up) {
                this._notebook.prevTab();
            } else if (symbol == Clutter.KEY_Page_Down) {
                this._notebook.nextTab();
            }
        }
        return false;
    },

    open : function() {
        if (this._open)
            return;

        if (!Main.pushModal(this._entry))
            return;

        this._notebook.selectIndex(0);
        this.actor.show();
        this._open = true;
        this._history.lastItem();

        Tweener.removeTweens(this.actor);

        // We inverse compensate for the slow-down so you can change the factor
        // through LookingGlass without long waits.
        Tweener.addTween(this.actor, { time: 0.5 / St.get_slow_down_factor(),
                                       transition: 'easeOutQuad',
                                       y: this._targetY
                                     });
    },

    close : function() {
        if (!this._open)
            return;

        this._objInspector.actor.hide();

        this._open = false;
        Tweener.removeTweens(this.actor);

        if (this._borderPaintTarget != null) {
            this._borderPaintTarget.disconnect(this._borderPaintId);
            this._borderPaintTarget.disconnect(this._borderDestroyId);
            this._borderPaintTarget = null;
        }

        Main.popModal(this._entry);

        Tweener.addTween(this.actor, { time: 0.5 / St.get_slow_down_factor(),
                                       transition: 'easeOutQuad',
                                       y: this._hiddenY,
                                       onComplete: Lang.bind(this, function () {
                                           this.actor.hide();
                                       })
                                     });
    }
});
Signals.addSignalMethods(LookingGlass.prototype);
