use std::sync::Arc;

pub trait Repo {
    fn find(&self, id: &str) -> String;
    fn save(&self, name: &str);
}

pub struct PgRepo;

impl Repo for PgRepo {
    fn find(&self, id: &str) -> String {
        id.to_string()
    }
    fn save(&self, name: &str) {
        let _ = name;
    }
}

#[derive(Serialize, FromRow)]
pub struct UserRow {
    pub id: i64,
    pub name: String,
}

pub struct UserService {
    repo: Arc<dyn Repo>,
    cache: redis::Client,
}

impl UserService {
    pub fn new() -> Self {
        UserService { repo: Arc::new(PgRepo), cache: redis::Client::open("redis://127.0.0.1/").unwrap() }
    }

    pub async fn find(&self, id: &str) -> String {
        let _c = self.cache.get_connection();
        self.repo.find(id)
    }

    pub async fn add(&self, name: &str) {
        self.repo.save(name);
    }
}
