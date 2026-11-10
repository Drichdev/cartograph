package main

import (
	"example.com/shop/internal/handlers"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	h := handlers.NewUserHandler()
	v1 := r.Group("/api/v1")
	v1.GET("/users/:id", h.Get)
	v1.POST("/users", h.Create)
	r.GET("/health", func(c *gin.Context) { c.String(200, "ok") })
	r.Run(":8080")
}
