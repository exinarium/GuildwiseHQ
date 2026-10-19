-- Project graphs (docs/design/project-graphs.md section 3): every project has a vault. A vault is stored in a remote
-- repository ('git', every vault so far) or as a folder on one workstation ('local': no remote, no sync).
ALTER TABLE vaults ADD COLUMN storage text NOT NULL DEFAULT 'git';
ALTER TABLE vaults ADD CONSTRAINT vaults_storage_check CHECK (storage IN ('git','local'));
-- Local vaults only: the workstation that holds the folder.
ALTER TABLE vaults ADD COLUMN local_workstation_id uuid;
ALTER TABLE vaults ADD CONSTRAINT vaults_local_check CHECK (storage = 'local' OR local_workstation_id IS NULL);
