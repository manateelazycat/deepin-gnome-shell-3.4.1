/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */
#ifndef __SHELL_JS_H__
#define __SHELL_JS_H__

#include <glib.h>

G_BEGIN_DECLS

gboolean shell_js_add_extension_importer (const char   *target_object_script,
                                          const char   *target_property,
                                          const char   *directory,
                                          GError      **error);

gchar   *shell_js_format_int_alternative_output (gint intval);

G_BEGIN_DECLS

#endif /* __SHELL_JS_H__ */
