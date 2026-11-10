<?php

use App\Http\Controllers\UserController;
use Illuminate\Support\Facades\Route;

Route::prefix('api')->group(function () {
    Route::get('/php-users/{id}', [UserController::class, 'show']);
    Route::post('/php-users', [UserController::class, 'store']);
    Route::middleware('auth:sanctum')->delete('/php-users/{id}', [UserController::class, 'destroy']);
});
