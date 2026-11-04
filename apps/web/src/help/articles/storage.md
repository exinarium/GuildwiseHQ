---
title: Storage connections
summary: Connect your own OneDrive, Google Drive, S3, folder or vault so forms and journeys write client files to your storage, not to Guildwise.
keywords: [storage, onedrive, sharepoint, google drive, s3, nas, folder, vault, connection, device sign-in, reconnect, upload]
order: 36
---

A **storage connection** is your own place for client files. Forms and journeys write there through your workstation; the Guildwise server never receives, stores or logs the files or the sign-in.

## Connect storage {#connect}

**Organization**, **Storage**, **Add storage** (Owners and Admins). Choose a display name, the type (OneDrive or SharePoint, Google Drive, S3-compatible, a local folder or NAS, or a folder in a vault) and one of your online workstations. Press **Connect**. For OneDrive and Google Drive open the sign-in page on any device and enter the code shown. For S3 enter the endpoint, bucket, region and access keys; for a folder or vault, its path. The sign-in or keys stay encrypted on that workstation.

## Test, reconnect, rename, remove {#manage}

**Test connection** asks the workstation to check it. A connection that shows **Needs re-authentication** needs **Reconnect**. **Rename** changes the display name. **Remove** deletes the connection and its sign-in from the workstation; files already written stay.

## How files are written {#writing}

Each file goes to the folder and name the form sets (for example `{journey}/{client}/{field}-{date}`). A file is never overwritten: a clash becomes `-2`, `-3`. If the storage cannot be reached the client sees a message to try again and nothing is marked complete.
