//go:build wireinject

package di

import (
	"example.com/shop/internal/handlers"
	"example.com/shop/internal/repo"
	"example.com/shop/internal/service"
	"github.com/google/wire"
)

func InitializeHandler() *handlers.UserHandler {
	wire.Build(
		handlers.NewUserHandler,
		service.NewUserService,
		wire.Bind(new(repo.Repository), new(*repo.MongoRepo)),
	)
	return nil
}
