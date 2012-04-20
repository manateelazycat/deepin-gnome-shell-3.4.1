/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include <string.h>

#include <meta/keybindings.h>

#include "shell-wm-private.h"
#include "shell-global.h"

struct _ShellWM {
  GObject parent;

  MetaPlugin *plugin;
};

/* Signals */
enum
{
  MINIMIZE,
  MAXIMIZE,
  UNMAXIMIZE,
  MAP,
  DESTROY,
  SWITCH_WORKSPACE,
  KILL_SWITCH_WORKSPACE,
  KILL_WINDOW_EFFECTS,

  LAST_SIGNAL
};

G_DEFINE_TYPE(ShellWM, shell_wm, G_TYPE_OBJECT);

static guint shell_wm_signals [LAST_SIGNAL] = { 0 };

static void
shell_wm_init (ShellWM *wm)
{
}

static void
shell_wm_finalize (GObject *object)
{
  G_OBJECT_CLASS (shell_wm_parent_class)->finalize (object);
}

static void
shell_wm_class_init (ShellWMClass *klass)
{
  GObjectClass *gobject_class = G_OBJECT_CLASS (klass);

  gobject_class->finalize = shell_wm_finalize;

  shell_wm_signals[MINIMIZE] =
    g_signal_new ("minimize",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 1,
                  META_TYPE_WINDOW_ACTOR);
  shell_wm_signals[MAXIMIZE] =
    g_signal_new ("maximize",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 5,
                  META_TYPE_WINDOW_ACTOR, G_TYPE_INT, G_TYPE_INT, G_TYPE_INT, G_TYPE_INT);
  shell_wm_signals[UNMAXIMIZE] =
    g_signal_new ("unmaximize",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 5,
                  META_TYPE_WINDOW_ACTOR, G_TYPE_INT, G_TYPE_INT, G_TYPE_INT, G_TYPE_INT);
  shell_wm_signals[MAP] =
    g_signal_new ("map",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 1,
                  META_TYPE_WINDOW_ACTOR);
  shell_wm_signals[DESTROY] =
    g_signal_new ("destroy",
                  G_TYPE_FROM_CLASS (klass),
                  G_SIGNAL_RUN_LAST,
                  0,
                  NULL, NULL, NULL,
                  G_TYPE_NONE, 1,
                  META_TYPE_WINDOW_ACTOR);
  shell_wm_signals[SWITCH_WORKSPACE] =
    g_signal_new ("switch-workspace",
		  G_TYPE_FROM_CLASS (klass),
		  G_SIGNAL_RUN_LAST,
		  0,
          NULL, NULL, NULL,
		  G_TYPE_NONE, 3,
                  G_TYPE_INT, G_TYPE_INT, G_TYPE_INT);
  shell_wm_signals[KILL_SWITCH_WORKSPACE] =
    g_signal_new ("kill-switch-workspace",
		  G_TYPE_FROM_CLASS (klass),
		  G_SIGNAL_RUN_LAST,
		  0,
          NULL, NULL, NULL,
		  G_TYPE_NONE, 0);
  shell_wm_signals[KILL_WINDOW_EFFECTS] =
    g_signal_new ("kill-window-effects",
		  G_TYPE_FROM_CLASS (klass),
		  G_SIGNAL_RUN_LAST,
		  0,
          NULL, NULL, NULL,
		  G_TYPE_NONE, 1,
		  META_TYPE_WINDOW_ACTOR);
}

void
_shell_wm_switch_workspace (ShellWM      *wm,
                            gint          from,
                            gint          to,
                            MetaMotionDirection direction)
{
  g_signal_emit (wm, shell_wm_signals[SWITCH_WORKSPACE], 0,
                 from, to, direction);
}

/**
 * shell_wm_completed_switch_workspace:
 * @wm: the ShellWM
 *
 * The plugin must call this when it has finished switching the
 * workspace.
 **/
void
shell_wm_completed_switch_workspace (ShellWM *wm)
{
  meta_plugin_switch_workspace_completed (wm->plugin);
}

/**
 * shell_wm_completed_minimize:
 * @wm: the ShellWM
 * @actor: the MetaWindowActor actor
 *
 * The plugin must call this when it has completed a window minimize effect.
 **/
void
shell_wm_completed_minimize (ShellWM         *wm,
                             MetaWindowActor *actor)
{
  meta_plugin_minimize_completed (wm->plugin, actor);
}

/**
 * shell_wm_completed_maximize:
 * @wm: the ShellWM
 * @actor: the MetaWindowActor actor
 *
 * The plugin must call this when it has completed a window maximize effect.
 **/
void
shell_wm_completed_maximize (ShellWM         *wm,
                             MetaWindowActor *actor)
{
  meta_plugin_maximize_completed (wm->plugin, actor);
}

/**
 * shell_wm_completed_unmaximize:
 * @wm: the ShellWM
 * @actor: the MetaWindowActor actor
 *
 * The plugin must call this when it has completed a window unmaximize effect.
 **/
void
shell_wm_completed_unmaximize (ShellWM         *wm,
                               MetaWindowActor *actor)
{
  meta_plugin_unmaximize_completed (wm->plugin, actor);
}

/**
 * shell_wm_completed_map:
 * @wm: the ShellWM
 * @actor: the MetaWindowActor actor
 *
 * The plugin must call this when it has completed a window map effect.
 **/
void
shell_wm_completed_map (ShellWM         *wm,
                        MetaWindowActor *actor)
{
  meta_plugin_map_completed (wm->plugin, actor);
}

/**
 * shell_wm_completed_destroy:
 * @wm: the ShellWM
 * @actor: the MetaWindowActor actor
 *
 * The plugin must call this when it has completed a window destroy effect.
 **/
void
shell_wm_completed_destroy (ShellWM         *wm,
                            MetaWindowActor *actor)
{
  meta_plugin_destroy_completed (wm->plugin, actor);
}

void
_shell_wm_kill_switch_workspace (ShellWM      *wm)
{
  g_signal_emit (wm, shell_wm_signals[KILL_SWITCH_WORKSPACE], 0);
}

void
_shell_wm_kill_window_effects (ShellWM         *wm,
                               MetaWindowActor *actor)
{
  g_signal_emit (wm, shell_wm_signals[KILL_WINDOW_EFFECTS], 0, actor);
}


void
_shell_wm_minimize (ShellWM         *wm,
                    MetaWindowActor *actor)
{
  g_signal_emit (wm, shell_wm_signals[MINIMIZE], 0, actor);
}

void
_shell_wm_maximize (ShellWM         *wm,
                    MetaWindowActor *actor,
                    int              target_x,
                    int              target_y,
                    int              target_width,
                    int              target_height)
{
  g_signal_emit (wm, shell_wm_signals[MAXIMIZE], 0, actor, target_x, target_y, target_width, target_height);
}

void
_shell_wm_unmaximize (ShellWM         *wm,
                      MetaWindowActor *actor,
                      int              target_x,
                      int              target_y,
                      int              target_width,
                      int              target_height)
{
  g_signal_emit (wm, shell_wm_signals[UNMAXIMIZE], 0, actor, target_x, target_y, target_width, target_height);
}

void
_shell_wm_map (ShellWM         *wm,
               MetaWindowActor *actor)
{
  g_signal_emit (wm, shell_wm_signals[MAP], 0, actor);
}

void
_shell_wm_destroy (ShellWM         *wm,
                   MetaWindowActor *actor)
{
  g_signal_emit (wm, shell_wm_signals[DESTROY], 0, actor);
}

/**
 * shell_wm_new:
 * @plugin: the #MetaPlugin
 *
 * Creates a new window management interface by hooking into @plugin.
 *
 * Return value: the new window-management interface
 **/
ShellWM *
shell_wm_new (MetaPlugin *plugin)
{
  ShellWM *wm;

  wm = g_object_new (SHELL_TYPE_WM, NULL);
  wm->plugin = plugin;

  return wm;
}
