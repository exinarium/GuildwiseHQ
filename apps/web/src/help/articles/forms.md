---
title: Forms
summary: Design a form with drag and drop, set the fields and their rules, add your company logo, preview it as a client sees it, and keep every saved version.
keywords: [forms, form builder, field, short text, long text, email, phone, number, date, dropdown, radio, checkbox, file upload, required, placeholder, help text, logo, preview, version, validation]
order: 34
---

A **form** is a set of questions your clients answer. You design it here; this page covers designing and saving. Publishing a form at a public address is a separate step.

## Build a form {#build-a-form}

Sidebar, **Forms**, **New form** (Owner and Admins; everyone else can look at forms and their preview).

1. Click **New form** and give it a title.
2. Add fields from the **palette**: drag a field type onto the canvas, or click it (or press Enter on it) to add it after the selected field. On a touch screen, tap it.
3. Click a field to edit it in the panel next to the canvas. With nothing selected the panel shows the form settings.
4. Reorder fields by dragging the grip, or focus the grip and press the up or down arrow keys. The **Move up**, **Move down**, **Duplicate** and **Delete** buttons on every field work without dragging.
5. Click **Save**. Reopening the form shows the same fields in the same order.

## Field types and properties {#field-types}

There are ten field types: short text, long text, email, phone, number, date, dropdown, radio buttons, checkboxes and file upload.

Every field has a **label**, **required**, and **help text**. The others depend on the type:

- **Placeholder** for text, email, phone, number and dropdown fields.
- **Minimum and maximum length** for short and long text; **minimum and maximum value** for numbers; **earliest and latest date** for dates.
- **Options**, one per line, for dropdown, radio and checkboxes.
- For a **file upload**: the allowed file types, the size limit (up to 25 MB), and the destination connection, folder and file name. The folder and name can use `{form}`, `{field}`, `{submission}`, `{date}`, `{time}`, `{original}`, `{ext}`, `{client}` and `{journey}`. Until a storage connection is set, the destination shows **Not set**.

The form settings hold the title, a description, the company logo, where the text answers go, and the text shown after a client submits.

## Preview {#preview}

The **Preview** tab shows the form exactly as a client will see it, with the same checks: an empty required field, an invalid email, a number outside its range, a date outside its range, and a file of the wrong type or over the size limit each show a clear message next to the field. Nothing is sent from the preview, and chosen files are never read.

## Versions {#versions}

Every save creates a new version. Earlier versions stay readable: open the **Versions** menu and pick one to look at it (it opens read-only). Saving without any change does not create a version. If someone else saved in the meantime you are asked to reload before saving, so nobody's work is overwritten.

## Company logo {#company-logo}

In the form settings choose a PNG, JPEG or WebP image of up to 512 KB. It is shown at the top of the form and of the preview. SVG images are not accepted. The logo is your organisation's branding picture, not client data; client answers and uploads never go to Guildwise.
