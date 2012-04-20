/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#ifdef HAVE_MALLINFO
#include <malloc.h>
#endif
#include <stdlib.h>
#include <string.h>

#include <clutter/clutter.h>
#include <clutter/x11/clutter-x11.h>
#include <gdk/gdk.h>
#include <gdk/gdkx.h>
#include <gtk/gtk.h>
#include <glib/gi18n-lib.h>
#include <girepository.h>
#include <meta/main.h>
#include <meta/meta-plugin.h>
#include <meta/prefs.h>
#include <telepathy-glib/debug.h>
#include <telepathy-glib/debug-sender.h>

#include "shell-a11y.h"
#include "shell-global.h"
#include "shell-global-private.h"
#include "shell-perf-log.h"
#include "st.h"

extern GType gnome_shell_plugin_get_type (void);

#define SHELL_DBUS_SERVICE "org.gnome.Shell"
#define MAGNIFIER_DBUS_SERVICE "org.gnome.Magnifier"

#define OVERRIDES_SCHEMA "org.gnome.shell.overrides"

static gboolean is_gdm_mode = FALSE;

#define DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER 1
#define DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER 4

static void
shell_dbus_acquire_name (GDBusProxy *bus,
                         guint32     request_name_flags,
                         guint32    *request_name_result,
                         gchar      *name,
                         gboolean    fatal)
{
  GError *error = NULL;
  GVariant *request_name_variant;

  if (!(request_name_variant = g_dbus_proxy_call_sync (bus,
                                                       "RequestName",
                                                       g_variant_new ("(su)", name, request_name_flags),
                                                       0, /* call flags */
                                                       -1, /* timeout */
                                                       NULL, /* cancellable */
                                                       &error)))
    {
      g_printerr ("failed to acquire %s: %s\n", name, error->message);
      if (!fatal)
        return;
      exit (1);
    }
  g_variant_get (request_name_variant, "(u)", request_name_result);
}

static void
shell_dbus_acquire_names (GDBusProxy *bus,
                          guint32     request_name_flags,
                          gchar      *name,
                          gboolean    fatal, ...) G_GNUC_NULL_TERMINATED;

static void
shell_dbus_acquire_names (GDBusProxy *bus,
                          guint32     request_name_flags,
                          gchar      *name,
                          gboolean    fatal, ...)
{
  va_list al;
  guint32 request_name_result;
  va_start (al, fatal);
  for (;;)
  {
    shell_dbus_acquire_name (bus,
                             request_name_flags,
                             &request_name_result,
                             name, fatal);
    name = va_arg (al, gchar *);
    if (!name)
      break;
    fatal = va_arg (al, gboolean);
  }
  va_end (al);
}

static void
shell_dbus_init (gboolean replace)
{
  GDBusConnection *session;
  GDBusProxy *bus;
  GError *error = NULL;
  guint32 request_name_flags;
  guint32 request_name_result;

  session = g_bus_get_sync (G_BUS_TYPE_SESSION, NULL, &error);

  if (error) {
    g_printerr ("Failed to connect to session bus: %s", error->message);
    exit (1);
  }

  bus = g_dbus_proxy_new_sync (session,
                               G_DBUS_PROXY_FLAGS_NONE,
                               NULL, /* interface info */
                               "org.freedesktop.DBus",
                               "/org/freedesktop/DBus",
                               "org.freedesktop.DBus",
                               NULL, /* cancellable */
                               &error);

  request_name_flags = G_BUS_NAME_OWNER_FLAGS_ALLOW_REPLACEMENT;
  if (replace)
    request_name_flags |= DBUS_NAME_FLAG_REPLACE_EXISTING;

  shell_dbus_acquire_name (bus,
                           request_name_flags,
                           &request_name_result,
                           SHELL_DBUS_SERVICE, TRUE);
  if (!(request_name_result == DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER
        || request_name_result == DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER))
    {
      g_printerr (SHELL_DBUS_SERVICE " already exists on bus and --replace not specified\n");
      exit (1);
    }

  /*
   * We always specify REPLACE_EXISTING to ensure we kill off
   * the existing service if it was running.
   */
  request_name_flags |= G_BUS_NAME_OWNER_FLAGS_REPLACE;

  shell_dbus_acquire_names (bus,
                            request_name_flags,
  /* Also grab org.gnome.Panel to replace any existing panel process */
                            "org.gnome.Panel", TRUE,
  /* ...and the org.gnome.Magnifier service. */
                            MAGNIFIER_DBUS_SERVICE, FALSE,
  /* ...and the org.freedesktop.Notifications service. */
                            "org.freedesktop.Notifications", FALSE,
                            NULL);
  /* ...and the on-screen keyboard service */
  shell_dbus_acquire_name (bus,
                           DBUS_NAME_FLAG_REPLACE_EXISTING,
                           &request_name_result,
                           "org.gnome.Caribou.Keyboard", FALSE);
  g_object_unref (bus);
  g_object_unref (session);
}

static void
shell_prefs_init (void)
{
  meta_prefs_override_preference_schema ("attach-modal-dialogs",
                                         OVERRIDES_SCHEMA);
  meta_prefs_override_preference_schema ("dynamic-workspaces",
                                         OVERRIDES_SCHEMA);
  meta_prefs_override_preference_schema ("workspaces-only-on-primary",
                                         OVERRIDES_SCHEMA);
  meta_prefs_override_preference_schema ("button-layout",
                                         OVERRIDES_SCHEMA);
  meta_prefs_override_preference_schema ("edge-tiling",
                                         OVERRIDES_SCHEMA);
}

static void
malloc_statistics_callback (ShellPerfLog *perf_log,
                            gpointer      data)
{
#ifdef HAVE_MALLINFO
  struct mallinfo info = mallinfo ();

  shell_perf_log_update_statistic_i (perf_log,
                                     "malloc.arenaSize",
                                     info.arena);
  shell_perf_log_update_statistic_i (perf_log,
                                     "malloc.mmapSize",
                                     info.hblkhd);
  shell_perf_log_update_statistic_i (perf_log,
                                     "malloc.usedSize",
                                     info.uordblks);
#endif
}

static void
shell_perf_log_init (void)
{
  ShellPerfLog *perf_log = shell_perf_log_get_default ();

  /* For probably historical reasons, mallinfo() defines the returned values,
   * even those in bytes as int, not size_t. We're determined not to use
   * more than 2G of malloc'ed memory, so are OK with that.
   */
  shell_perf_log_define_statistic (perf_log,
                                   "malloc.arenaSize",
                                   "Amount of memory allocated by malloc() with brk(), in bytes",
                                   "i");
  shell_perf_log_define_statistic (perf_log,
                                   "malloc.mmapSize",
                                   "Amount of memory allocated by malloc() with mmap(), in bytes",
                                   "i");
  shell_perf_log_define_statistic (perf_log,
                                   "malloc.usedSize",
                                   "Amount of malloc'ed memory currently in use",
                                   "i");

  shell_perf_log_add_statistics_callback (perf_log,
                                          malloc_statistics_callback,
                                          NULL, NULL);
}

static void
default_log_handler (const char     *log_domain,
                     GLogLevelFlags  log_level,
                     const char     *message,
                     gpointer        data)
{
  TpDebugSender *sender = data;
  GTimeVal now;

  g_get_current_time (&now);

  tp_debug_sender_add_message (sender, &now, log_domain, log_level, message);

  /* Filter out telepathy-glib logs, we don't want to flood Shell's output
   * with those. */
  if (!g_str_has_prefix (log_domain, "tp-glib"))
    g_log_default_handler (log_domain, log_level, message, data);
}

static gboolean
print_version (const gchar    *option_name,
               const gchar    *value,
               gpointer        data,
               GError        **error)
{
  g_print ("GNOME Shell %s\n", VERSION);
  exit (0);
}

GOptionEntry gnome_shell_options[] = {
  {
    "version", 0, G_OPTION_FLAG_NO_ARG, G_OPTION_ARG_CALLBACK,
    print_version,
    N_("Print version"),
    NULL
  },
  {
    "gdm-mode", 0, 0, G_OPTION_ARG_NONE,
    &is_gdm_mode,
    N_("Mode used by GDM for login screen"),
    NULL
  },
  { NULL }
};

int
main (int argc, char **argv)
{
  GOptionContext *ctx;
  GError *error = NULL;
  ShellSessionType session_type;
  int ecode;
  TpDebugSender *sender;

  g_type_init ();

  bindtextdomain (GETTEXT_PACKAGE, LOCALEDIR);
  bind_textdomain_codeset (GETTEXT_PACKAGE, "UTF-8");
  textdomain (GETTEXT_PACKAGE);

  ctx = meta_get_option_context ();
  g_option_context_add_main_entries (ctx, gnome_shell_options, GETTEXT_PACKAGE);
  if (!g_option_context_parse (ctx, &argc, &argv, &error))
    {
      g_printerr ("%s: %s\n", argv[0], error->message);
      exit (1);
    }

  g_option_context_free (ctx);

  meta_plugin_type_register (gnome_shell_plugin_get_type ());

  /* Prevent meta_init() from causing gtk to load gail and at-bridge */
  g_setenv ("NO_GAIL", "1", TRUE);
  g_setenv ("NO_AT_BRIDGE", "1", TRUE);
  meta_init ();
  g_unsetenv ("NO_GAIL");
  g_unsetenv ("NO_AT_BRIDGE");

  /* FIXME: Add gjs API to set this stuff and don't depend on the
   * environment.  These propagate to child processes.
   */
  g_setenv ("GJS_DEBUG_OUTPUT", "stderr", TRUE);
  g_setenv ("GJS_DEBUG_TOPICS", "JS ERROR;JS LOG", TRUE);

  shell_dbus_init (meta_get_replace_current_wm ());
  shell_a11y_init ();
  shell_perf_log_init ();
  shell_prefs_init ();

  g_irepository_prepend_search_path (GNOME_SHELL_PKGLIBDIR);
#if HAVE_BLUETOOTH
  g_irepository_prepend_search_path (BLUETOOTH_DIR);
#endif

  /* Turn on telepathy-glib debugging but filter it out in
   * default_log_handler. This handler also exposes all the logs over D-Bus
   * using TpDebugSender. */
  tp_debug_set_flags ("all");

  sender = tp_debug_sender_dup ();
  g_log_set_default_handler (default_log_handler, sender);

  /* Initialize the global object */
  if (is_gdm_mode)
      session_type = SHELL_SESSION_GDM;
  else
      session_type = SHELL_SESSION_USER;

  _shell_global_init ("session-type", session_type, NULL);

  ecode = meta_run ();

  if (g_getenv ("GNOME_SHELL_ENABLE_CLEANUP"))
    {
      g_printerr ("Doing final cleanup...\n");
      g_object_unref (shell_global_get ());
    }

  g_object_unref (sender);

  return ecode;
}
