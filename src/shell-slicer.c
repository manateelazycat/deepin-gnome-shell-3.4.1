/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

/**
 * SECTION:shell-slicer
 * @short_description: Display only part of another actor
 *
 * A #StBin that has 0 minimum size, and will clip its child
 * in the middle.
 */

#include "config.h"

#include "shell-slicer.h"

G_DEFINE_TYPE (ShellSlicer,
               shell_slicer,
               ST_TYPE_BIN);

static void
shell_slicer_get_preferred_width (ClutterActor *self,
                                  gfloat        for_height,
                                  gfloat       *min_width_p,
                                  gfloat       *natural_width_p)
{
  ClutterActor *child = st_bin_get_child (ST_BIN (self));
  StThemeNode *theme_node = st_widget_get_theme_node (ST_WIDGET (self));

  st_theme_node_adjust_for_height (theme_node, &for_height);

  if (min_width_p)
    *min_width_p = 0;

  if (child == NULL)
    {
      if (natural_width_p)
        *natural_width_p = 0;
    }
  else
    {
      _st_actor_get_preferred_width (child, for_height, FALSE,
                                     NULL,
                                     natural_width_p);
    }

  st_theme_node_adjust_preferred_width (theme_node, min_width_p, natural_width_p);
}

static void
shell_slicer_get_preferred_height (ClutterActor *self,
                                   gfloat        for_width,
                                   gfloat       *min_height_p,
                                   gfloat       *natural_height_p)
{
  ClutterActor *child = st_bin_get_child (ST_BIN (self));
  StThemeNode *theme_node = st_widget_get_theme_node (ST_WIDGET (self));

  st_theme_node_adjust_for_width (theme_node, &for_width);

  if (min_height_p)
    *min_height_p = 0;

  if (child == NULL)
    {
      if (natural_height_p)
        *natural_height_p = 0;
    }
  else
    {
      _st_actor_get_preferred_height (child, for_width, FALSE,
                                      NULL,
                                      natural_height_p);
    }

  st_theme_node_adjust_preferred_height (theme_node, min_height_p, natural_height_p);
}

static void
shell_slicer_allocate (ClutterActor           *self,
                       const ClutterActorBox  *box,
                       ClutterAllocationFlags  flags)
{
  ClutterActor *child;

  clutter_actor_set_allocation (self, box, flags);

  child = st_bin_get_child (ST_BIN (self));
  if (child)
    clutter_actor_allocate_preferred_size (child, flags);
}

static void
shell_slicer_paint_child (ShellSlicer *self)
{
  ClutterActor *child;
  ClutterActorBox self_box;
  ClutterActorBox child_box;
  float width, height, child_width, child_height;
  StAlign x_align, y_align;
  double x_align_factor, y_align_factor;

  child = st_bin_get_child (ST_BIN (self));

  if (!child)
    return;

  st_bin_get_alignment (ST_BIN (self), &x_align, &y_align);
  _st_get_align_factors (x_align, y_align,
                         &x_align_factor, &y_align_factor);

  clutter_actor_get_allocation_box (CLUTTER_ACTOR (self), &self_box);
  clutter_actor_get_allocation_box (child, &child_box);

  width = self_box.x2 - self_box.x1;
  height = self_box.y2 - self_box.y1;
  child_width = child_box.x2 - child_box.x1;
  child_height = child_box.y2 - child_box.y1;

  cogl_push_matrix ();

  cogl_clip_push_rectangle (0, 0, width, height);
  cogl_translate ((int)(0.5 + x_align_factor * (width - child_width)),
                  (int)(0.5 + y_align_factor * (height - child_height)),
                  0);

  clutter_actor_paint (child);

  cogl_clip_pop ();

  cogl_pop_matrix ();
}

static void
shell_slicer_paint (ClutterActor *self)
{
  st_widget_paint_background (ST_WIDGET (self));

  shell_slicer_paint_child (SHELL_SLICER (self));
}

static void
shell_slicer_pick (ClutterActor       *self,
                   const ClutterColor *pick_color)
{
  shell_slicer_paint_child (SHELL_SLICER (self));
}

static void
shell_slicer_class_init (ShellSlicerClass *klass)
{
  ClutterActorClass *actor_class = CLUTTER_ACTOR_CLASS (klass);

  actor_class->get_preferred_width = shell_slicer_get_preferred_width;
  actor_class->get_preferred_height = shell_slicer_get_preferred_height;
  actor_class->allocate = shell_slicer_allocate;
  actor_class->paint = shell_slicer_paint;
  actor_class->pick = shell_slicer_pick;
}

static void
shell_slicer_init (ShellSlicer *actor)
{
}
