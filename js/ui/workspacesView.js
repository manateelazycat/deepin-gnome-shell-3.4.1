// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Signals = imports.signals;

const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Overview = imports.ui.overview;
const Tweener = imports.ui.tweener;
const Workspace = imports.ui.workspace;
const WorkspaceThumbnail = imports.ui.workspaceThumbnail;

const WORKSPACE_SWITCH_TIME = 0.25;
// Note that mutter has a compile-time limit of 36
const MAX_WORKSPACES = 16;

const OVERRIDE_SCHEMA = 'org.gnome.shell.overrides';

const CONTROLS_POP_IN_TIME = 0.1;


const WorkspacesView = new Lang.Class({
    Name: 'WorkspacesView',

    _init: function(workspaces) {
        this.actor = new St.Widget({ style_class: 'workspaces-view' });

        // The actor itself isn't a drop target, so we don't want to pick on its area
        this.actor.set_size(0, 0);

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this.actor.connect('style-changed', Lang.bind(this,
            function() {
                let node = this.actor.get_theme_node();
                this._spacing = node.get_length('spacing');
                this._updateWorkspaceActors(false);
            }));

        this._width = 0;
        this._height = 0;
        this._x = 0;
        this._y = 0;
        this._clipX = 0;
        this._clipY = 0;
        this._clipWidth = 0;
        this._clipHeight = 0;
        this._workspaceRatioSpacing = 0;
        this._spacing = 0;
        this._animating = false; // tweening
        this._scrolling = false; // swipe-scrolling
        this._animatingScroll = false; // programatically updating the adjustment
        this._zoomOut = false; // zoom to a larger area
        this._inDrag = false; // dragging a window

        this._settings = new Gio.Settings({ schema: OVERRIDE_SCHEMA });
        this._updateExtraWorkspacesId =
            this._settings.connect('changed::workspaces-only-on-primary',
                                   Lang.bind(this, this._updateExtraWorkspaces));

        let activeWorkspaceIndex = global.screen.get_active_workspace_index();
        this._workspaces = workspaces;

        // Add workspace actors
        for (let w = 0; w < global.screen.n_workspaces; w++)
            this._workspaces[w].actor.reparent(this.actor);
        this._workspaces[activeWorkspaceIndex].actor.raise_top();

        this._updateExtraWorkspaces();

        // Position/scale the desktop windows and their children after the
        // workspaces have been created. This cannot be done first because
        // window movement depends on the Workspaces object being accessible
        // as an Overview member.
        this._overviewShowingId =
            Main.overview.connect('showing',
                                 Lang.bind(this, function() {
                for (let w = 0; w < this._workspaces.length; w++)
                    this._workspaces[w].zoomToOverview();
                if (!this._extraWorkspaces)
                    return;
                for (let w = 0; w < this._extraWorkspaces.length; w++)
                    this._extraWorkspaces[w].zoomToOverview();
        }));
        this._overviewShownId =
            Main.overview.connect('shown',
                                 Lang.bind(this, function() {
                this.actor.set_clip(this._clipX, this._clipY,
                                    this._clipWidth, this._clipHeight);
        }));

        this.scrollAdjustment = new St.Adjustment({ value: activeWorkspaceIndex,
                                                    lower: 0,
                                                    page_increment: 1,
                                                    page_size: 1,
                                                    step_increment: 0,
                                                    upper: this._workspaces.length });
        this.scrollAdjustment.connect('notify::value',
                                      Lang.bind(this, this._onScroll));

        this._switchWorkspaceNotifyId =
            global.window_manager.connect('switch-workspace',
                                          Lang.bind(this, this._activeWorkspaceChanged));

        this._itemDragBeginId = Main.overview.connect('item-drag-begin',
                                                      Lang.bind(this, this._dragBegin));
        this._itemDragEndId = Main.overview.connect('item-drag-end',
                                                     Lang.bind(this, this._dragEnd));
        this._windowDragBeginId = Main.overview.connect('window-drag-begin',
                                                        Lang.bind(this, this._dragBegin));
        this._windowDragEndId = Main.overview.connect('window-drag-end',
                                                      Lang.bind(this, this._dragEnd));
    },

    _updateExtraWorkspaces: function() {
        this._destroyExtraWorkspaces();

        if (!this._settings.get_boolean('workspaces-only-on-primary'))
            return;

        this._extraWorkspaces = [];
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            if (i == Main.layoutManager.primaryIndex)
                continue;

            let ws = new Workspace.Workspace(null, i);
            ws.setGeometry(monitors[i].x, monitors[i].y,
                           monitors[i].width, monitors[i].height);
            global.overlay_group.add_actor(ws.actor);
            this._extraWorkspaces.push(ws);
        }
    },

    _destroyExtraWorkspaces: function() {
        if (!this._extraWorkspaces)
            return;

        for (let m = 0; m < this._extraWorkspaces.length; m++)
            this._extraWorkspaces[m].destroy();
        this._extraWorkspaces = null;
    },

    setGeometry: function(x, y, width, height, spacing) {
      if (this._x == x && this._y == y &&
          this._width == width && this._height == height)
          return;
        this._width = width;
        this._height = height;
        this._x = x;
        this._y = y;
        this._workspaceRatioSpacing = spacing;

        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].setGeometry(x, y, width, height);
    },

    setClipRect: function(x, y, width, height) {
        this._clipX = x;
        this._clipY = y;
        this._clipWidth = width;
        this._clipHeight = height;
    },

    _lookupWorkspaceForMetaWindow: function (metaWindow) {
        for (let i = 0; i < this._workspaces.length; i++) {
            if (this._workspaces[i].containsMetaWindow(metaWindow))
                return this._workspaces[i];
        }
        return null;
    },

    getActiveWorkspace: function() {
        let active = global.screen.get_active_workspace_index();
        return this._workspaces[active];
    },

    hide: function() {
        let activeWorkspaceIndex = global.screen.get_active_workspace_index();
        let activeWorkspace = this._workspaces[activeWorkspaceIndex];

        activeWorkspace.actor.raise_top();

       this.actor.remove_clip(this._x, this._y, this._width, this._height);

        for (let w = 0; w < this._workspaces.length; w++)
            this._workspaces[w].zoomFromOverview();
        if (!this._extraWorkspaces)
            return;
        for (let w = 0; w < this._extraWorkspaces.length; w++)
            this._extraWorkspaces[w].zoomFromOverview();
    },

    destroy: function() {
        this.actor.destroy();
    },

    syncStacking: function(stackIndices) {
        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].syncStacking(stackIndices);
        if (!this._extraWorkspaces)
            return;
        for (let i = 0; i < this._extraWorkspaces.length; i++)
            this._extraWorkspaces[i].syncStacking(stackIndices);
    },

    updateWindowPositions: function() {
        for (let w = 0; w < this._workspaces.length; w++)
            this._workspaces[w].positionWindows(Workspace.WindowPositionFlags.ANIMATE);
    },

    _scrollToActive: function(showAnimation) {
        let active = global.screen.get_active_workspace_index();

        this._updateWorkspaceActors(showAnimation);
        this._updateScrollAdjustment(active, showAnimation);
    },

    // Update workspace actors parameters
    // @showAnimation: iff %true, transition between states
    _updateWorkspaceActors: function(showAnimation) {
        let active = global.screen.get_active_workspace_index();

        this._animating = showAnimation;

        for (let w = 0; w < this._workspaces.length; w++) {
            let workspace = this._workspaces[w];

            Tweener.removeTweens(workspace.actor);

            let y = (w - active) * (this._height + this._spacing + this._workspaceRatioSpacing);

            if (showAnimation) {
                let params = { y: y,
                               time: WORKSPACE_SWITCH_TIME,
                               transition: 'easeOutQuad'
                             };
                // we have to call _updateVisibility() once before the
                // animation and once afterwards - it does not really
                // matter which tween we use, so we pick the first one ...
                if (w == 0) {
                    this._updateVisibility();
                    params.onComplete = Lang.bind(this,
                        function() {
                            this._animating = false;
                            this._updateVisibility();
                        });
                }
                Tweener.addTween(workspace.actor, params);
            } else {
                workspace.actor.set_position(0, y);
                if (w == 0)
                    this._updateVisibility();
            }
        }
    },

    _updateVisibility: function() {
        let active = global.screen.get_active_workspace_index();

        for (let w = 0; w < this._workspaces.length; w++) {
            let workspace = this._workspaces[w];
            if (this._animating || this._scrolling) {
                workspace.actor.show();
            } else {
                if (this._inDrag)
                    workspace.actor.visible = (Math.abs(w - active) <= 1);
                else
                    workspace.actor.visible = (w == active);
            }
        }
    },

    _updateScrollAdjustment: function(index, showAnimation) {
        if (this._scrolling)
            return;

        this._animatingScroll = true;

        if (showAnimation) {
            Tweener.addTween(this.scrollAdjustment, {
               value: index,
               time: WORKSPACE_SWITCH_TIME,
               transition: 'easeOutQuad',
               onComplete: Lang.bind(this,
                   function() {
                       this._animatingScroll = false;
                   })
            });
        } else {
            this.scrollAdjustment.value = index;
            this._animatingScroll = false;
        }
    },

    updateWorkspaces: function(oldNumWorkspaces, newNumWorkspaces) {
        let active = global.screen.get_active_workspace_index();

        Tweener.addTween(this.scrollAdjustment,
                         { upper: newNumWorkspaces,
                           time: WORKSPACE_SWITCH_TIME,
                           transition: 'easeOutQuad'
                         });

        if (newNumWorkspaces > oldNumWorkspaces) {
            for (let w = oldNumWorkspaces; w < newNumWorkspaces; w++) {
                this._workspaces[w].setGeometry(this._x, this._y,
                                                this._width, this._height);
                this.actor.add_actor(this._workspaces[w].actor);
            }

            this._updateWorkspaceActors(false);
        }

        this._scrollToActive(true);
    },

    _activeWorkspaceChanged: function(wm, from, to, direction) {
        if (this._scrolling)
            return;

        this._scrollToActive(true);
    },

    _onDestroy: function() {
        this._destroyExtraWorkspaces();
        this.scrollAdjustment.run_dispose();
        Main.overview.disconnect(this._overviewShowingId);
        Main.overview.disconnect(this._overviewShownId);
        global.window_manager.disconnect(this._switchWorkspaceNotifyId);
        this._settings.disconnect(this._updateExtraWorkspacesId);

        if (this._inDrag)
            this._dragEnd();

        if (this._itemDragBeginId > 0) {
            Main.overview.disconnect(this._itemDragBeginId);
            this._itemDragBeginId = 0;
        }
        if (this._itemDragEndId > 0) {
            Main.overview.disconnect(this._itemDragEndId);
            this._itemDragEndId = 0;
        }
        if (this._windowDragBeginId > 0) {
            Main.overview.disconnect(this._windowDragBeginId);
            this._windowDragBeginId = 0;
        }
        if (this._windowDragEndId > 0) {
            Main.overview.disconnect(this._windowDragEndId);
            this._windowDragEndId = 0;
        }
    },

    _dragBegin: function() {
        if (this._scrolling)
            return;

        this._inDrag = true;
        this._firstDragMotion = true;

        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);
    },

    _onDragMotion: function(dragEvent) {
        if (Main.overview.animationInProgress)
             return DND.DragMotionResult.CONTINUE;

        if (this._firstDragMotion) {
            this._firstDragMotion = false;
            for (let i = 0; i < this._workspaces.length; i++)
                this._workspaces[i].setReservedSlot(dragEvent.dragActor._delegate);
            if (!this._extraWorkspaces)
                return DND.DragMotionResult.CONTINUE;

            for (let i = 0; i < this._extraWorkspaces.length; i++)
                this._extraWorkspaces[i].setReservedSlot(dragEvent.dragActor._delegate);
        }

        return DND.DragMotionResult.CONTINUE;
    },

    _dragEnd: function() {
        DND.removeDragMonitor(this._dragMonitor);
        this._inDrag = false;

        for (let i = 0; i < this._workspaces.length; i++)
            this._workspaces[i].setReservedSlot(null);

        if (!this._extraWorkspaces)
            return;
        for (let i = 0; i < this._extraWorkspaces.length; i++)
            this._extraWorkspaces[i].setReservedSlot(null);
    },

    startSwipeScroll: function() {
        this._scrolling = true;
    },

    endSwipeScroll: function(result) {
        this._scrolling = false;

        if (result == Overview.SwipeScrollResult.CLICK) {
            let [x, y, mod] = global.get_pointer();
            let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
                                                      x, y);

            // Only switch to the workspace when there's no application
            // windows open. The problem is that it's too easy to miss
            // an app window and get the wrong one focused.
            let active = global.screen.get_active_workspace_index();
            if (this._workspaces[active].isEmpty() &&
                this.actor.contains(actor))
                Main.overview.hide();
        }

        // Make sure title captions etc are shown as necessary
        this._updateVisibility();
    },

    // sync the workspaces' positions to the value of the scroll adjustment
    // and change the active workspace if appropriate
    _onScroll: function(adj) {
        if (this._animatingScroll)
            return;

        let active = global.screen.get_active_workspace_index();
        let current = Math.round(adj.value);

        if (active != current) {
            let metaWorkspace = this._workspaces[current].metaWorkspace;
            metaWorkspace.activate(global.get_current_time());
        }

        let last = this._workspaces.length - 1;
        let firstWorkspaceY = this._workspaces[0].actor.y;
        let lastWorkspaceY = this._workspaces[last].actor.y;
        let workspacesHeight = lastWorkspaceY - firstWorkspaceY;

        if (adj.upper == 1)
            return;

        let currentY = firstWorkspaceY;
        let newY =  - adj.value / (adj.upper - 1) * workspacesHeight;

        let dy = newY - currentY;

        for (let i = 0; i < this._workspaces.length; i++) {
            this._workspaces[i].actor.visible = Math.abs(i - adj.value) <= 1;
            this._workspaces[i].actor.y += dy;
        }
    },

    _getWorkspaceIndexToRemove: function() {
        return global.screen.get_active_workspace_index();
    }
});
Signals.addSignalMethods(WorkspacesView.prototype);


const WorkspacesDisplay = new Lang.Class({
    Name: 'WorkspacesDisplay',

    _init: function() {
        this.actor = new Shell.GenericContainer();
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));
        this.actor.connect('notify::mapped', Lang.bind(this, this._setupSwipeScrolling));
        this.actor.connect('parent-set', Lang.bind(this, this._parentSet));
        this.actor.set_clip_to_allocation(true);

        let controls = new St.Bin({ style_class: 'workspace-controls',
                                    request_mode: Clutter.RequestMode.WIDTH_FOR_HEIGHT,
                                    y_align: St.Align.START,
                                    y_fill: true });
        this._controls = controls;
        this.actor.add_actor(controls);

        controls.reactive = true;
        controls.track_hover = true;
        controls.connect('notify::hover',
                         Lang.bind(this, this._onControlsHoverChanged));
        controls.connect('scroll-event',
                         Lang.bind(this, this._onScrollEvent));

        this._primaryIndex = Main.layoutManager.primaryIndex;

        this._thumbnailsBox = new WorkspaceThumbnail.ThumbnailsBox();
        controls.add_actor(this._thumbnailsBox.actor);

        this._workspacesViews = null;
        this._primaryScrollAdjustment = null;

        this._settings = new Gio.Settings({ schema: OVERRIDE_SCHEMA });
        this._settings.connect('changed::workspaces-only-on-primary',
                               Lang.bind(this,
                                         this._workspacesOnlyOnPrimaryChanged));
        this._workspacesOnlyOnPrimaryChanged();

        this._inDrag = false;
        this._cancelledDrag = false;

        this._controlsInitiallyHovered = false;
        this._alwaysZoomOut = false;
        this._zoomOut = false;
        this._zoomFraction = 0;

        this._updateAlwaysZoom();

        // If we stop hiding the overview on layout changes, we will need to
        // update the _workspacesViews here
        Main.layoutManager.connect('monitors-changed', Lang.bind(this, this._updateAlwaysZoom));

        Main.xdndHandler.connect('drag-begin', Lang.bind(this, function(){
            this._alwaysZoomOut = true;
        }));

        Main.xdndHandler.connect('drag-end', Lang.bind(this, function(){
            this._alwaysZoomOut = false;
            this._updateAlwaysZoom();
        }));

        this._switchWorkspaceNotifyId = 0;

        this._nWorkspacesChangedId = 0;
        this._itemDragBeginId = 0;
        this._itemDragCancelledId = 0;
        this._itemDragEndId = 0;
        this._windowDragBeginId = 0;
        this._windowDragCancelledId = 0;
        this._windowDragEndId = 0;
        this._notifyOpacityId = 0;
        this._swipeScrollBeginId = 0;
        this._swipeScrollEndId = 0;
    },

    show: function() {
        if(!this._alwaysZoomOut) {
            let [mouseX, mouseY] = global.get_pointer();
            let [x, y] = this._controls.get_transformed_position();
            let [width, height] = this._controls.get_transformed_size();
            let visibleWidth = this._controls.get_theme_node().get_length('visible-width');
            let rtl = (Clutter.get_default_text_direction () == Clutter.TextDirection.LTR);
            if(rtl)
                x = x + width - visibleWidth;
            if(mouseX > x - 0.5 && mouseX < x + visibleWidth + 0.5 &&
               mouseY > y - 0.5 && mouseY < y + height + 0.5)
                this._controlsInitiallyHovered = true;
        }

        this._zoomOut = this._alwaysZoomOut;
        this._zoomFraction = this._alwaysZoomOut ? 1 : 0;
        this._updateZoom();

        this._controls.show();
        this._thumbnailsBox.show();

        this._updateWorkspacesViews();

        this._restackedNotifyId =
            global.screen.connect('restacked',
                                  Lang.bind(this, this._onRestacked));

        if (this._nWorkspacesChangedId == 0)
            this._nWorkspacesChangedId = global.screen.connect('notify::n-workspaces',
                                                               Lang.bind(this, this._workspacesChanged));
        if (this._itemDragBeginId == 0)
            this._itemDragBeginId = Main.overview.connect('item-drag-begin',
                                                          Lang.bind(this, this._dragBegin));
        if (this._itemDragCancelledId == 0)
            this._itemDragCancelledId = Main.overview.connect('item-drag-cancelled',
                                                              Lang.bind(this, this._dragCancelled));
        if (this._itemDragEndId == 0)
            this._itemDragEndId = Main.overview.connect('item-drag-end',
                                                        Lang.bind(this, this._dragEnd));
        if (this._windowDragBeginId == 0)
            this._windowDragBeginId = Main.overview.connect('window-drag-begin',
                                                            Lang.bind(this, this._dragBegin));
        if (this._windowDragCancelledId == 0)
            this._windowDragCancelledId = Main.overview.connect('window-drag-cancelled',
                                                            Lang.bind(this, this._dragCancelled));
        if (this._windowDragEndId == 0)
            this._windowDragEndId = Main.overview.connect('window-drag-end',
                                                          Lang.bind(this, this._dragEnd));

        this._onRestacked();
    },

    zoomFromOverview: function() {
        for (let i = 0; i < this._workspacesViews.length; i++) {
            this._workspacesViews[i].hide();
        }
    },

    hide: function() {
        this._controls.hide();
        this._thumbnailsBox.hide();

        if (!this._alwaysZoomOut)
            this.zoomFraction = 0;

        if (this._restackedNotifyId > 0){
            global.screen.disconnect(this._restackedNotifyId);
            this._restackedNotifyId = 0;
        }
        if (this._itemDragBeginId > 0) {
            Main.overview.disconnect(this._itemDragBeginId);
            this._itemDragBeginId = 0;
        }
        if (this._itemDragCancelledId > 0) {
            Main.overview.disconnect(this._itemDragCancelledId);
            this._itemDragCancelledId = 0;
        }
        if (this._itemDragEndId > 0) {
            Main.overview.disconnect(this._itemDragEndId);
            this._itemDragEndId = 0;
        }
        if (this._windowDragBeginId > 0) {
            Main.overview.disconnect(this._windowDragBeginId);
            this._windowDragBeginId = 0;
        }
        if (this._windowDragCancelledId > 0) {
            Main.overview.disconnect(this._windowDragCancelledId);
            this._windowDragCancelledId = 0;
        }
        if (this._windowDragEndId > 0) {
            Main.overview.disconnect(this._windowDragEndId);
            this._windowDragEndId = 0;
        }

        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].destroy();
        this._workspacesViews = null;

        for (let i = 0; i < this._workspaces.length; i++)
            for (let w = 0; w < this._workspaces[i].length; w++) {
                this._workspaces[i][w].disconnectAll();
                this._workspaces[i][w].destroy();
            }
    },

    _setupSwipeScrolling: function() {
        if (this._swipeScrollBeginId)
            Main.overview.disconnect(this._swipeScrollBeginId);
        this._swipeScrollBeginId = 0;

        if (this._swipeScrollEndId)
            Main.overview.disconnect(this._swipeScrollEndId);
        this._swipeScrollEndId = 0;

        if (!this.actor.mapped)
            return;

        let direction = Overview.SwipeScrollDirection.VERTICAL;
        Main.overview.setScrollAdjustment(this._scrollAdjustment,
                                          direction);
        this._swipeScrollBeginId = Main.overview.connect('swipe-scroll-begin',
            Lang.bind(this, function() {
                for (let i = 0; i < this._workspacesViews.length; i++)
                    this._workspacesViews[i].startSwipeScroll();
            }));
        this._swipeScrollEndId = Main.overview.connect('swipe-scroll-end',
           Lang.bind(this, function(overview, result) {
                for (let i = 0; i < this._workspacesViews.length; i++)
                    this._workspacesViews[i].endSwipeScroll(result);
           }));
    },

    _workspacesOnlyOnPrimaryChanged: function() {
        this._workspacesOnlyOnPrimary = this._settings.get_boolean('workspaces-only-on-primary');

        if (!Main.overview.visible)
            return;

        this._updateWorkspacesViews();
    },

    _updateWorkspacesViews: function() {
        if (this._workspacesViews)
            for (let i = 0; i < this._workspacesViews.length; i++)
                this._workspacesViews[i].destroy();

        if (this._workspaces)
            for (let i = 0; i < this._workspaces.length; i++)
                for (let w = 0; w < this._workspaces[i].length; w++)
                    this._workspaces[i][w].destroy();

        this._workspacesViews = [];
        this._workspaces = [];
        let monitors = Main.layoutManager.monitors;
        for (let i = 0; i < monitors.length; i++) {
            if (this._workspacesOnlyOnPrimary && i != this._primaryIndex)
                continue;  // we are only interested in the primary monitor

            let monitorWorkspaces = [];
            for (let w = 0; w < global.screen.n_workspaces; w++) {
                let metaWorkspace = global.screen.get_workspace_by_index(w);
                monitorWorkspaces.push(new Workspace.Workspace(metaWorkspace, i));
            }

            this._workspaces.push(monitorWorkspaces);

            let view = new WorkspacesView(monitorWorkspaces);
            if (this._workspacesOnlyOnPrimary || i == this._primaryIndex) {
                this._scrollAdjustment = view.scrollAdjustment;
                this._scrollAdjustment.connect('notify::value',
                                               Lang.bind(this, this._scrollValueChanged));
                this._setupSwipeScrolling();
            }
            this._workspacesViews.push(view);
        }

        this._updateWorkspacesGeometry();

        for (let i = 0; i < this._workspacesViews.length; i++)
            global.overlay_group.add_actor(this._workspacesViews[i].actor);
    },

    _scrollValueChanged: function() {
        if (this._workspacesOnlyOnPrimary)
            return;

        for (let i = 0; i < this._workspacesViews.length; i++) {
            if (i == this._primaryIndex)
                continue;

            let adjustment = this._workspacesViews[i].scrollAdjustment;
            // the adjustments work in terms of workspaces, so the
            // values map directly
            adjustment.value = this._scrollAdjustment.value;
        }
    },

    _getPrimaryView: function() {
        if (!this._workspacesViews)
            return null;
        if (this._workspacesOnlyOnPrimary)
            return this._workspacesViews[0];
        else
            return this._workspacesViews[this._primaryIndex];
    },

    activeWorkspaceHasMaximizedWindows: function() {
        return this._getPrimaryView().getActiveWorkspace().hasMaximizedWindows();
    },

    // zoomFraction property allows us to tween the controls sliding in and out
    set zoomFraction(fraction) {
        this._zoomFraction = fraction;
        this.actor.queue_relayout();
    },

    get zoomFraction() {
        return this._zoomFraction;
    },

    _updateAlwaysZoom: function()  {
        // Always show the pager if workspaces are actually used,
        // e.g. there are windows on more than one
        this._alwaysZoomOut = global.screen.n_workspaces > 2;

        if (this._alwaysZoomOut)
            return;

        let monitors = Main.layoutManager.monitors;
        let primary = Main.layoutManager.primaryMonitor;

        /* Look for any monitor to the right of the primary, if there is
         * one, we always keep zoom out, otherwise its hard to reach
         * the thumbnail area without passing into the next monitor. */
        for (let i = 0; i < monitors.length; i++) {
            if (monitors[i].x >= primary.x + primary.width) {
                this._alwaysZoomOut = true;
                break;
            }
        }
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        // pass through the call in case the child needs it, but report 0x0
        this._controls.get_preferred_width(forHeight);
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        // pass through the call in case the child needs it, but report 0x0
        this._controls.get_preferred_height(forWidth);
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();

        let totalWidth = box.x2 - box.x1;

        // width of the controls
        let [controlsMin, controlsNatural] = this._controls.get_preferred_width(box.y2 - box.y1);

        // Amount of space on the screen we reserve for the visible control
        let controlsVisible = this._controls.get_theme_node().get_length('visible-width');
        let controlsReserved = controlsVisible * (1 - this._zoomFraction) + controlsNatural * this._zoomFraction;

        let rtl = (Clutter.get_default_text_direction () == Clutter.TextDirection.LTR);
        if (rtl) {
            childBox.x2 = controlsReserved;
            childBox.x1 = childBox.x2 - controlsNatural;
        } else {
            childBox.x1 = totalWidth - controlsReserved;
            childBox.x2 = childBox.x1 + controlsNatural;
        }

        childBox.y1 = 0;
        childBox.y2 = box.y2- box.y1;
        this._controls.allocate(childBox, flags);

        this._updateWorkspacesGeometry();
    },

    _parentSet: function(actor, oldParent) {
        if (oldParent && this._notifyOpacityId)
            oldParent.disconnect(this._notifyOpacityId);
        this._notifyOpacityId = 0;

        Meta.later_add(Meta.LaterType.BEFORE_REDRAW, Lang.bind(this,
            function() {
                let newParent = this.actor.get_parent();
                if (!newParent)
                    return;

                // This is kinda hackish - we want the primary view to
                // appear as parent of this.actor, though in reality it
                // is added directly to overlay_group
                this._notifyOpacityId = newParent.connect('notify::opacity',
                    Lang.bind(this, function() {
                        let opacity = this.actor.get_parent().opacity;
                        let primaryView = this._getPrimaryView();
                        if (!primaryView)
                            return;
                        primaryView.actor.opacity = opacity;
                        if (opacity == 0)
                            primaryView.actor.hide();
                        else
                            primaryView.actor.show();
                    }));
        }));
    },

    _updateWorkspacesGeometry: function() {
        if (!this._workspacesViews)
            return;

        let fullWidth = this.actor.allocation.x2 - this.actor.allocation.x1;
        let fullHeight = this.actor.allocation.y2 - this.actor.allocation.y1;

        let width = fullWidth;
        let height = fullHeight;

        let [controlsMin, controlsNatural] = this._controls.get_preferred_width(height);
        let controlsVisible = this._controls.get_theme_node().get_length('visible-width');

        let [x, y] = this.actor.get_transformed_position();

        let rtl = (Clutter.get_default_text_direction () == Clutter.TextDirection.LTR);

        let clipWidth = width - controlsVisible;
        let clipHeight = (fullHeight / fullWidth) * clipWidth;
        let clipX = rtl ? x + controlsVisible : x;
        let clipY = y + (fullHeight - clipHeight) / 2;

        if (this._zoomOut) {
            width -= controlsNatural;
            if (rtl)
                x += controlsNatural;
        } else {
            width -= controlsVisible;
            if (rtl)
                x += controlsVisible;
        }

        height = (fullHeight / fullWidth) * width;
        let difference = fullHeight - height;
        y += difference / 2;


        let monitors = Main.layoutManager.monitors;
        let m = 0;
        for (let i = 0; i < monitors.length; i++) {
            if (i == this._primaryIndex) {
                this._workspacesViews[m].setClipRect(clipX, clipY,
                                                     clipWidth, clipHeight);
                this._workspacesViews[m].setGeometry(x, y, width, height,
                                                     difference);
                m++;
            } else if (!this._workspacesOnlyOnPrimary) {
                this._workspacesViews[m].setClipRect(monitors[i].x,
                                                     monitors[i].y,
                                                     monitors[i].width,
                                                     monitors[i].height);
                this._workspacesViews[m].setGeometry(monitors[i].x,
                                                     monitors[i].y,
                                                     monitors[i].width,
                                                     monitors[i].height, 0);
                m++;
            }
        }
    },

    _onRestacked: function() {
        let stack = global.get_window_actors();
        let stackIndices = {};

        for (let i = 0; i < stack.length; i++) {
            // Use the stable sequence for an integer to use as a hash key
            stackIndices[stack[i].get_meta_window().get_stable_sequence()] = i;
        }

        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].syncStacking(stackIndices);

        this._thumbnailsBox.syncStacking(stackIndices);
    },

    _workspacesChanged: function() {
        let oldNumWorkspaces = this._workspaces[0].length;
        let newNumWorkspaces = global.screen.n_workspaces;
        let active = global.screen.get_active_workspace_index();

        if (oldNumWorkspaces == newNumWorkspaces)
            return;

        this._updateAlwaysZoom();
        this._updateZoom();

        if (this._workspacesViews == null)
            return;

        let lostWorkspaces = [];
        if (newNumWorkspaces > oldNumWorkspaces) {
            let monitors = Main.layoutManager.monitors;
            let m = 0;
            for (let i = 0; i < monitors.length; i++) {
                if (this._workspacesOnlyOnPrimaryChanged &&
                    i != this._primaryIndex)
                    continue;

                // Assume workspaces are only added at the end
                for (let w = oldNumWorkspaces; w < newNumWorkspaces; w++) {
                    let metaWorkspace = global.screen.get_workspace_by_index(w);
                    this._workspaces[m++][w] =
                        new Workspace.Workspace(metaWorkspace, i);
                }
            }

            this._thumbnailsBox.addThumbnails(oldNumWorkspaces, newNumWorkspaces - oldNumWorkspaces);
        } else {
            // Assume workspaces are only removed sequentially
            // (e.g. 2,3,4 - not 2,4,7)
            let removedIndex;
            let removedNum = oldNumWorkspaces - newNumWorkspaces;
            for (let w = 0; w < oldNumWorkspaces; w++) {
                let metaWorkspace = global.screen.get_workspace_by_index(w);
                if (this._workspaces[0][w].metaWorkspace != metaWorkspace) {
                    removedIndex = w;
                    break;
                }
            }

            for (let i = 0; i < this._workspaces.length; i++) {
                lostWorkspaces = this._workspaces[i].splice(removedIndex,
                                                            removedNum);

                for (let l = 0; l < lostWorkspaces.length; l++) {
                    lostWorkspaces[l].disconnectAll();
                    lostWorkspaces[l].destroy();
                }
            }

            this._thumbnailsBox.removeThumbmails(removedIndex, removedNum);
        }

        for (let i = 0; i < this._workspacesViews.length; i++)
            this._workspacesViews[i].updateWorkspaces(oldNumWorkspaces,
                                                      newNumWorkspaces);
    },

    _updateZoom : function() {
        if (Main.overview.animationInProgress)
            return;

        let shouldZoom = this._alwaysZoomOut || this._controls.hover;
        if (shouldZoom != this._zoomOut) {
            this._zoomOut = shouldZoom;
            this._updateWorkspacesGeometry();

            if (!this._workspacesViews)
                return;

            Tweener.addTween(this,
                             { zoomFraction: this._zoomOut ? 1 : 0,
                               time: WORKSPACE_SWITCH_TIME,
                               transition: 'easeOutQuad' });

            for (let i = 0; i < this._workspacesViews.length; i++)
                this._workspacesViews[i].updateWindowPositions();
        }
    },

    _onControlsHoverChanged: function() {
        if(!this._controls.hover)
            this._controlsInitiallyHovered = false;
        if(!this._controlsInitiallyHovered)
            this._updateZoom();
    },

    _dragBegin: function() {
        this._inDrag = true;
        this._cancelledDrag = false;
        this._dragMonitor = {
            dragMotion: Lang.bind(this, this._onDragMotion)
        };
        DND.addDragMonitor(this._dragMonitor);
    },

    _dragCancelled: function() {
        this._cancelledDrag = true;
        DND.removeDragMonitor(this._dragMonitor);
    },

    _onDragMotion: function(dragEvent) {
        let controlsHovered = this._controls.contains(dragEvent.targetActor);
        this._controls.set_hover(controlsHovered);

        return DND.DragMotionResult.CONTINUE;
    },

    _dragEnd: function() {
        this._inDrag = false;

        // We do this deferred because drag-end is emitted before dnd.js emits
        // event/leave events that were suppressed during the drag. If we didn't
        // defer this, we'd zoom out then immediately zoom in because of the
        // enter event we received. That would normally be invisible but we
        // might as well avoid it.
        Meta.later_add(Meta.LaterType.BEFORE_REDRAW,
                       Lang.bind(this, this._updateZoom));
    },

    _onScrollEvent: function (actor, event) {
        switch ( event.get_scroll_direction() ) {
        case Clutter.ScrollDirection.UP:
            Main.wm.actionMoveWorkspaceUp();
            break;
        case Clutter.ScrollDirection.DOWN:
            Main.wm.actionMoveWorkspaceDown();
            break;
        }
    }
});
Signals.addSignalMethods(WorkspacesDisplay.prototype);
