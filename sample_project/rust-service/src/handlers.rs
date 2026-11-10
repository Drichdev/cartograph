use crate::service::UserService;

pub async fn list_users() -> String {
    let svc = UserService::new();
    svc.find("1").await
}

pub async fn create_user() {
    let svc = UserService::new();
    svc.add("x").await;
}

pub fn dead_helper() -> u32 {
    42
}
