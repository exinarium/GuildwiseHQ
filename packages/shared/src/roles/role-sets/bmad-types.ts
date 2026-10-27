/** One BMAD agent's persona, as `scripts/bmad-roles/generate.mjs` reads it from the agent's `customize.toml`. */
export interface BmadPersona {
  /** BMAD's name for the agent (Mary). Not used in Guildwise: an agent's name is the one it was hired with. */
  name: string;
  title: string;
  role: string;
  identity: string;
  communicationStyle: string;
  principles: string[];
  /** The BMAD skills the agent's menu points at. */
  menuSkills: string[];
  /** Path of the file in the BMAD checkout. */
  source: string;
}

/** A section of a BMAD agent's working method, rendered with its defaults and without BMAD's own machinery. */
export interface BmadMethodSection {
  id: string;
  title: string;
  text: string;
  /** Sentences left out because they name BMAD machinery (its scripts, config, memlog or ticket files). */
  dropped: number;
  source: string;
}
