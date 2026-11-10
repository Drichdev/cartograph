import 'package:flutter/material.dart';

import '../services/user_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final UserService _service = UserService();
  String _name = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final user = await _service.fetchUser('a@x.fr');
    setState(() => _name = user.name);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(body: Center(child: Text(_name)));
  }
}
