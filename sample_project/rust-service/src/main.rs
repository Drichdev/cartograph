mod handlers;
mod service;

use axum::{routing::get, Router};

#[tokio::main]
async fn main() {
    let app = Router::new().route("/rs-users", get(handlers::list_users).post(handlers::create_user));
    axum::serve(tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap(), app).await.unwrap();
}
