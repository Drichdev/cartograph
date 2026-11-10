import 'package:dio/dio.dart';
import 'package:sqflite/sqflite.dart';

import '../models/user.dart';

const apiToken = 'sk-live-abcdef123456';

class UserService {
  final Dio _dio = Dio();
  Database? _db;

  Future<User> fetchUser(String email) async {
    final res = await _dio.get('https://api.example.com/users/$email');
    return User.fromJson(res.data);
  }

  Future<void> save(User user) async {
    await _dio.post('https://api.example.com/users/', data: user.toJson());
  }

  Future<void> search(String name) async {
    await _db!.rawQuery("SELECT * FROM users WHERE name = '$name'");
  }

  void neverUsed() {}
}
