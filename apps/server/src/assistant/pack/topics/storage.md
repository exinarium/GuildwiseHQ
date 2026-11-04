### Storage connections
Connect your own OneDrive, Google Drive, S3, folder or vault so forms and journeys write client files to your storage, not to Guildwise.
- Connect storage: Organization, Storage, Add storage (Owners and Admins). Choose a display name, the type (OneDrive or SharePoint, Google Drive, S3-compatible, a local folder or NAS, or a folder in a vault) and one of your online workstations. Press Connect.…
- Test, reconnect, rename, remove: Test connection asks the workstation to check it. A connection that shows Needs re-authentication needs Reconnect. Rename changes the display name. Remove deletes the connection and its sign-in from the workstation; files already written stay.
- How files are written: Each file goes to the folder and name the form sets (for example {journey}/{client}/{field}-{date}). A file is never overwritten: a clash becomes -2, -3. If the storage cannot be reached the client sees a message to try again and nothing is marked complete.
