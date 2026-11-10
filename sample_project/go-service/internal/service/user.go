package service

import (
	"database/sql"
	"fmt"
	"net/http"

	"example.com/shop/internal/repo"
	"github.com/redis/go-redis/v9"
)

const apiKey = "sk-abcdef123456"

type UserService struct {
	repo  repo.Repository
	cache *redis.Client
	db    *sql.DB
}

func NewUserService() *UserService {
	return &UserService{}
}

func (s *UserService) Find(id string) *repo.User {
	s.cache.Get(nil, "user:"+id)
	u, _ := s.repo.FindByID(id)
	return u
}

func (s *UserService) Create(name string) {
	s.repo.Save(&repo.User{Name: name})
	http.Get("http://localhost:8000/users/1")
}

func (s *UserService) Search(name string) {
	s.db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))
}

func LegacyExport() string {
	return "legacy"
}
