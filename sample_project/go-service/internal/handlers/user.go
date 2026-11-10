package handlers

import (
	"example.com/shop/internal/service"
	"github.com/gin-gonic/gin"
)

type UserHandler struct {
	svc *service.UserService
}

func NewUserHandler() *UserHandler {
	return &UserHandler{svc: service.NewUserService()}
}

func (h *UserHandler) Get(c *gin.Context) {
	u := h.svc.Find(c.Param("id"))
	c.JSON(200, u)
}

func (h *UserHandler) Create(c *gin.Context) {
	h.svc.Create("x")
}
