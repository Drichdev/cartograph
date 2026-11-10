package repo

import "go.mongodb.org/mongo-driver/mongo"

type User struct {
	ID   string `bson:"_id" json:"id"`
	Name string `bson:"name" json:"name"`
}

type Repository interface {
	FindByID(id string) (*User, error)
	Save(u *User) error
}

type MongoRepo struct {
	coll *mongo.Collection
}

func (r *MongoRepo) FindByID(id string) (*User, error) {
	r.coll.FindOne(nil, id)
	return nil, nil
}

func (r *MongoRepo) Save(u *User) error {
	r.coll.InsertOne(nil, u)
	return nil
}
