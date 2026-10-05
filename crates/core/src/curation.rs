//! What you decided about clips, kept in `library/curation.json` so re-analysis never undoes it:
//!
//! - **deleted**: highlights and lowlights you deleted; never shown or rendered again.
//! - **evicted**: clips removed to stay under the storage limit; the moment stays in the library
//!   and is rendered again only if you ask (Watch).
//! - **folders**: your own lists (best moments, a montage, ...). Clips in a folder are never
//!   removed by the storage limit.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

pub const FILE: &str = "curation.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Curation {
    pub deleted: BTreeSet<String>,
    pub evicted: BTreeSet<String>,
    pub folders: Vec<Folder>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// Highlight / lowlight ids, in the order you added them.
    pub items: Vec<String>,
    /// Unix seconds.
    pub created: i64,
}

impl Curation {
    pub fn load(root: &Path) -> Self {
        std::fs::read_to_string(root.join(FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        let tmp = root.join(format!("{FILE}.tmp"));
        std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap_or_default())?;
        std::fs::rename(tmp, root.join(FILE))
    }

    /// In a folder: kept whatever the storage limit says.
    pub fn protected(&self, id: &str) -> bool {
        self.folders.iter().any(|f| f.items.iter().any(|i| i == id))
    }

    /// Rendered automatically (not deleted, not removed for space).
    pub fn auto_render(&self, id: &str) -> bool {
        !self.deleted.contains(id) && !self.evicted.contains(id)
    }
}
